"""
MajuBox — Servidor Central / Painel Admin
Gerencia máquinas, DVDs, playlists, gêneros, licenças e pagamentos PIX
Integração com API Mercado Pago para recebimento PIX
"""
import json, sqlite3, uuid, hashlib, os, threading, secrets, re
from datetime import datetime, timedelta
from pathlib import Path
from flask import Flask, request, jsonify, render_template_string, redirect, url_for, session, send_from_directory
from werkzeug.exceptions import HTTPException
try:
    from flask_cors import CORS
except Exception:
    CORS = None
import urllib.request, urllib.error, urllib.parse

app = Flask(__name__)
if CORS:
    CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=False)
app.secret_key = os.environ.get("MAJUBOX_SECRET", secrets.token_hex(32))

@app.errorhandler(Exception)
def handle_exception(e):
    if isinstance(e, HTTPException):
        if request.path.startswith('/api/') or request.path.startswith('/machine') or request.path.startswith('/proxy'):
            return jsonify({"ok": False, "error": e.description, "status_code": e.code, "path": request.path}), e.code
        return e
    import traceback
    print("[SERVER ERROR]", repr(e))
    traceback.print_exc()
    return jsonify({"ok": False, "error": str(e), "type": e.__class__.__name__}), 500

DATA_DIR = Path(os.environ.get("DATA_DIR", os.environ.get("RENDER_DISK_PATH", str(Path(__file__).parent))))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = Path(os.environ.get("DB_PATH", str(DATA_DIR / "majubox.db")))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "admin123")

# ─── Mercado Pago ─────────────────────────────────────────────────────────────
MP_ACCESS_TOKEN = os.environ.get("MP_ACCESS_TOKEN", "")
PIX_CONFIG_PATH = Path(os.environ.get("PIX_CONFIG_PATH", str(DATA_DIR / "pix_config.json")))
YOUTUBE_CONFIG_PATH = Path(os.environ.get("YOUTUBE_CONFIG_PATH", str(DATA_DIR / "youtube_config.json")))
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")

GENRE_COVERS_DIR = Path(os.environ.get("GENRE_COVERS_DIR", str(DATA_DIR / "genre_covers")))
GENRE_COVERS_DIR.mkdir(exist_ok=True)

DEFAULT_GENRE_COVERS = {
    "Sertanejo": "/genre_covers/sertanejo.png",
    "Pagode": "/genre_covers/pagode.png",
    "Forró": "/genre_covers/forro.png",
    "Axé": "/genre_covers/axe.png",
    "Funk": "/genre_covers/funk.png",
    "Rock": "/genre_covers/rock.png",
    "Karaokê": "/genre_covers/karaoke.png",
    "MPB": "/genre_covers/mpb.png",
    "Samba": "/genre_covers/samba.png",
    "Pop": "/genre_covers/pop.png",
    "Eletrônica": "/genre_covers/eletronica.png",
    "Gospel": "/genre_covers/gospel.png",
}

# Filtro padrão para importar vídeos do YouTube
# Bloqueia Shorts e vídeos muito longos: mínimo 2 minutos, máximo 7 minutos.
YOUTUBE_MIN_SECONDS = 2 * 60
YOUTUBE_MAX_SECONDS = 7 * 60

def _is_probable_short_video(video):
    """Retorna True quando parece Shorts ou fora do tempo permitido."""
    title = str(video.get("title", "") or "").lower()
    dur = int(video.get("duration_seconds", 0) or 0)
    if not dur:
        return True
    if dur < YOUTUBE_MIN_SECONDS or dur > YOUTUBE_MAX_SECONDS:
        return True
    # Muitos Shorts oficiais vêm com hashtag ou palavra Shorts no título.
    # O filtro principal continua sendo o tempo, mas isso ajuda a bloquear também.
    if "#shorts" in title or "#short" in title or "youtube shorts" in title:
        return True
    return False


def _normalize_song_title_for_duplicate(title):
    """Normaliza título para evitar repetidos no Karaokê entre canais diferentes."""
    title = str(title or "").lower()
    title = re.sub(r"\([^)]*\)", " ", title)
    title = re.sub(r"\[[^\]]*\]", " ", title)
    title = re.sub(r"\b(karaok[eê]|karaoke|oficial|official|lyrics?|letra|legendado|hd|4k|ao vivo|live|cover|playback|instrumental)\b", " ", title)
    title = re.sub(r"[^a-z0-9áàâãéêíóôõúçñ]+", " ", title)
    title = re.sub(r"\s+", " ", title).strip()
    return title

def _load_saved_youtube_key():
    """Carrega a chave da API do YouTube salva no painel admin, se existir."""
    global YOUTUBE_API_KEY
    if YOUTUBE_API_KEY:
        return
    try:
        if YOUTUBE_CONFIG_PATH.exists():
            cfg = json.loads(YOUTUBE_CONFIG_PATH.read_text(encoding="utf-8"))
            YOUTUBE_API_KEY = cfg.get("youtube_api_key", "") or ""
    except Exception as e:
        print(f"[YOUTUBE CONFIG] Nao consegui carregar chave YouTube: {e}")

_load_saved_youtube_key()

def _load_saved_mp_token():
    """Carrega token salvo no painel admin, se existir."""
    global MP_ACCESS_TOKEN
    if MP_ACCESS_TOKEN:
        return
    try:
        if PIX_CONFIG_PATH.exists():
            cfg = json.loads(PIX_CONFIG_PATH.read_text(encoding="utf-8"))
            MP_ACCESS_TOKEN = cfg.get("mp_token", "") or ""
    except Exception as e:
        print(f"[PIX CONFIG] Nao consegui carregar token Mercado Pago: {e}")

_load_saved_mp_token()

def get_license_price():
    """Valor da licença mensal configurado no painel PIX."""
    try:
        if PIX_CONFIG_PATH.exists():
            cfg = json.loads(PIX_CONFIG_PATH.read_text(encoding="utf-8"))
            raw = str(cfg.get("license_price", "10.00")).replace(",", ".").strip()
            value = float(raw or 10.0)
            return max(0.01, value)
    except Exception as e:
        print(f"[PIX CONFIG] Erro ao carregar valor da licença: {e}")
    return 10.0

# Para Mercado Livre, usar:
ML_ACCESS_TOKEN = os.environ.get("ML_ACCESS_TOKEN", "")
ML_CLIENT_ID = os.environ.get("ML_CLIENT_ID", "")
ML_CLIENT_SECRET = os.environ.get("ML_CLIENT_SECRET", "")

# ─── Banco de dados ───────────────────────────────────────────────────────────
def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS machines (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            location    TEXT,
            token       TEXT UNIQUE NOT NULL,
            hwid        TEXT UNIQUE,
            active      INTEGER DEFAULT 1,
            license_ok  INTEGER DEFAULT 1,
            license_exp TEXT,
            admin_pass  TEXT DEFAULT '1234',
            pix_key     TEXT,
            pix_name    TEXT,
            pix_city    TEXT,
            mp_token    TEXT,
            last_seen   TEXT,
            last_ip     TEXT,
            last_user_agent TEXT,
            last_error  TEXT,
            app_version TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS genres (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL,
            cover_url   TEXT,
            sort_order  INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS dvds (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            genre_id    INTEGER REFERENCES genres(id) ON DELETE CASCADE,
            name        TEXT NOT NULL,
            cover_url   TEXT,
            sort_order  INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS playlists (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            genre_id     INTEGER REFERENCES genres(id) ON DELETE CASCADE,
            dvd_id       INTEGER REFERENCES dvds(id) ON DELETE SET NULL,
            title        TEXT NOT NULL,
            artist       TEXT,
            youtube_id   TEXT NOT NULL,
            video_url    TEXT,
            cover_url    TEXT,
            mode         TEXT DEFAULT 'jukebox',
            sort_order   INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS payments (
            id           TEXT PRIMARY KEY,
            machine_id   TEXT REFERENCES machines(id),
            amount       REAL DEFAULT 0,
            credits      INTEGER DEFAULT 0,
            status       TEXT DEFAULT 'pending',
            pix_qr       TEXT,
            pix_code     TEXT,
            mp_id        TEXT,
            payment_type TEXT DEFAULT 'license',
            credited     INTEGER DEFAULT 0,
            created_at   TEXT DEFAULT (datetime('now')),
            paid_at      TEXT
        );

        CREATE TABLE IF NOT EXISTS plays (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            machine_id   TEXT,
            playlist_id  INTEGER,
            played_at    TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS license_revenue (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            machine_id   TEXT REFERENCES machines(id),
            month        TEXT NOT NULL,
            total        REAL DEFAULT 0,
            created_at   TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS machine_revenue_log (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            machine_id   TEXT REFERENCES machines(id),
            amount       REAL DEFAULT 0,
            recorded_at  TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS terms_acceptance (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            machine_id      TEXT,
            hwid            TEXT,
            token           TEXT,
            machine_name    TEXT,
            terms_version   TEXT,
            app_version     TEXT,
            accepted_at     TEXT,
            terms_hash      TEXT,
            ip              TEXT,
            user_agent      TEXT,
            created_at      TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS karaoke_scores (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            machine_id      TEXT,
            hwid            TEXT,
            token           TEXT,
            name            TEXT NOT NULL,
            score           INTEGER NOT NULL,
            song_title      TEXT,
            created_at      TEXT DEFAULT (datetime('now'))
        );
        """)

        # Migração: versões antigas do banco podem não ter a coluna credited.
        cols = [r[1] for r in db.execute("PRAGMA table_info(payments)").fetchall()]
        if "credited" not in cols:
            db.execute("ALTER TABLE payments ADD COLUMN credited INTEGER DEFAULT 0")

        # Migrações seguras para bancos antigos
        for sql in [
            "ALTER TABLE machines ADD COLUMN hwid TEXT",
            "ALTER TABLE machines ADD COLUMN mp_token TEXT",
            "ALTER TABLE machines ADD COLUMN last_seen TEXT",
            "ALTER TABLE machines ADD COLUMN last_ip TEXT",
            "ALTER TABLE machines ADD COLUMN last_user_agent TEXT",
            "ALTER TABLE machines ADD COLUMN last_error TEXT",
            "ALTER TABLE machines ADD COLUMN app_version TEXT",
            "ALTER TABLE payments ADD COLUMN credited INTEGER DEFAULT 0",
            "ALTER TABLE payments ADD COLUMN payment_type TEXT DEFAULT 'license'",
            "ALTER TABLE payments ADD COLUMN pix_qr TEXT",
            "ALTER TABLE payments ADD COLUMN pix_code TEXT",
            "ALTER TABLE payments ADD COLUMN mp_id TEXT",
            "ALTER TABLE payments ADD COLUMN paid_at TEXT",
            "ALTER TABLE terms_acceptance ADD COLUMN terms_hash TEXT",
            "ALTER TABLE terms_acceptance ADD COLUMN user_agent TEXT",
        ]:
            try:
                db.execute(sql)
            except Exception:
                pass

        # Gêneros padrão
        count = db.execute("SELECT COUNT(*) FROM genres").fetchone()[0]
        if count == 0:
            default_genres = [
                ("Sertanejo", "", 0),
                ("Pagode", "", 1),
                ("Forró", "", 2),
                ("Axé", "", 3),
                ("Funk", "", 4),
                ("Rock", "", 5),
                ("Karaokê", "", 6),
                ("MPB", "", 7),
                ("Samba", "", 8),
                ("Pop", "", 9),
                ("Eletrônica", "", 10),
                ("Gospel", "", 11),
            ]
            for name, cover, order in default_genres:
                db.execute("INSERT INTO genres(name,cover_url,sort_order) VALUES(?,?,?)",
                           (name, cover, order))

        # Garante que todos os gêneros padrão existam, mesmo em banco antigo.
        existing_names = {str(r[0]).lower(): r[0] for r in db.execute("SELECT name FROM genres").fetchall()}
        current_max_order = db.execute("SELECT COALESCE(MAX(sort_order), 0) FROM genres").fetchone()[0] or 0
        for genre_name in DEFAULT_GENRE_COVERS.keys():
            if genre_name.lower() not in existing_names:
                current_max_order += 1
                db.execute(
                    "INSERT INTO genres(name,cover_url,sort_order) VALUES(?,?,?)",
                    (genre_name, DEFAULT_GENRE_COVERS.get(genre_name, ""), current_max_order)
                )

        # Atualiza capas padrão dos gêneros, sem apagar capas que você já configurou.
        for genre_name, cover_path in DEFAULT_GENRE_COVERS.items():
            db.execute(
                "UPDATE genres SET cover_url=? WHERE name=? AND (cover_url IS NULL OR cover_url='')",
                (cover_path, genre_name)
            )

        db.commit()

init_db()

@app.route("/api/health", methods=["GET"])
def api_health():
    return jsonify({"ok": True, "status": "online", "service": "MajuBox", "time": datetime.now().isoformat()})

# ─── Status online/offline das máquinas ───────────────────────────────────────
def _parse_dt_safe(value):
    """Converte datas SQLite/ISO em datetime, sem quebrar o painel."""
    if not value:
        return None
    try:
        txt = str(value).replace("Z", "").replace("T", " ")
        # remove microssegundos longos se vierem em formato ISO
        return datetime.fromisoformat(txt)
    except Exception:
        try:
            return datetime.strptime(str(value), "%Y-%m-%d %H:%M:%S")
        except Exception:
            return None


def _machine_status_dict(machine_row, online_limit_seconds=90):
    """Define bolinha verde/vermelha conforme último contato da máquina."""
    m = dict(machine_row)
    last_dt = _parse_dt_safe(m.get("last_seen"))
    if last_dt:
        seconds = max(0, int((datetime.utcnow() - last_dt).total_seconds()))
    else:
        seconds = None
    online = seconds is not None and seconds <= online_limit_seconds
    m["online"] = online
    m["status_color"] = "green" if online else "red"
    m["status_text"] = "Online" if online else "Offline"
    m["last_seen_seconds"] = seconds
    if seconds is None:
        m["last_seen_label"] = "Nunca conectou"
    elif seconds < 60:
        m["last_seen_label"] = f"há {seconds}s"
    elif seconds < 3600:
        m["last_seen_label"] = f"há {seconds // 60}min"
    else:
        m["last_seen_label"] = f"há {seconds // 3600}h"
    return m


def _machine_diagnostics(machine_row):
    """Diagnóstico simples para o botão Testar conexão no painel."""
    m = _machine_status_dict(machine_row)
    issues = []
    warnings = []
    if not m.get("active"):
        issues.append("Máquina bloqueada no servidor.")
    if not m.get("license_ok"):
        warnings.append("Licença vencida ou bloqueada. A máquina deve pedir PIX de liberação.")
    exp = _parse_dt_safe(m.get("license_exp"))
    if exp and datetime.now() > exp:
        warnings.append("Data da licença já venceu.")
    if not m.get("token"):
        issues.append("Máquina sem token cadastrado.")
    if not m.get("hwid"):
        warnings.append("Máquina ainda sem HWID salvo. Abra a máquina e clique em Salvar e Conectar.")
    if not m.get("last_seen"):
        issues.append("Esta máquina nunca chamou /api/machine/check.")
    elif not m.get("online"):
        issues.append("Sem contato recente. Verifique internet da máquina, URL do servidor e se o app está aberto.")
    if m.get("last_error"):
        warnings.append("Último erro informado: " + str(m.get("last_error"))[:180])
    if not m.get("mp_token"):
        warnings.append("Token Mercado Pago do CLIENTE não configurado. PIX de créditos pode falhar.")
    return m, issues, warnings

@app.route("/genre_covers/<path:filename>")
def genre_cover_file(filename):
    """Serve as capas PNG dos gêneros para o painel e para a máquina."""
    return send_from_directory(GENRE_COVERS_DIR, filename)

# ─── Funções PIX (Mercado Pago) ───────────────────────────────────────────────
def create_pix_payment(amount, description, machine_id, access_token=None):
    """Cria pagamento PIX via API Mercado Pago.
    Se access_token for informado, usa o token do cliente/máquina para créditos.
    Sem access_token, usa MP_ACCESS_TOKEN do servidor para licença mensal.
    """
    token_to_use = access_token or MP_ACCESS_TOKEN
    if not token_to_use:
        return {"ok": False, "qr_code": "", "pix_code": "", "mp_id": "", "error": "Token MP não configurado"}

    try:
        payment_id = str(uuid.uuid4())
        headers = {
            "Authorization": f"Bearer {token_to_use}",
            "Content-Type": "application/json",
            "X-Idempotency-Key": payment_id
        }
        body = {
            "transaction_amount": float(amount),
            "description": description,
            "payment_method_id": "pix",
            "payer": {
                "email": f"machine_{machine_id}@majubox.com"
            }
        }
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            "https://api.mercadopago.com/v1/payments",
            data=data, headers=headers, method="POST"
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            rd = json.loads(r.read())
            mp_id = str(rd.get("id", ""))
            pt = rd.get("point_of_interaction", {}).get("transaction_data", {})
            qr_code = pt.get("qr_code_base64", "")
            pix_code = pt.get("qr_code", "")
            return {"ok": True, "qr_code": qr_code, "pix_code": pix_code, "mp_id": mp_id}
    except Exception as e:
        print(f"[PIX ERROR] {e}")
        return {"ok": False, "qr_code": "", "pix_code": "", "mp_id": "", "error": str(e)}


def check_pix_payment(mp_id, access_token=None):
    """Verifica se pagamento PIX foi aprovado"""
    token_to_use = access_token or MP_ACCESS_TOKEN
    if not token_to_use or not mp_id:
        return None
    try:
        headers = {"Authorization": f"Bearer {token_to_use}"}
        req = urllib.request.Request(
            f"https://api.mercadopago.com/v1/payments/{mp_id}",
            headers=headers
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            rd = json.loads(r.read())
            return rd.get("status")  # approved, pending, rejected, etc.
    except Exception as e:
        print(f"[PIX CHECK ERROR] {e}")
        return None


# ─── API para as Máquinas ─────────────────────────────────────────────────────

@app.route("/machine/check", methods=["POST"])
@app.route("/proxy/check", methods=["POST"])
@app.route("/api/machine/check", methods=["POST"])
def machine_check():
    """Máquina verifica licença, cadastra automaticamente e recebe conteúdo."""
    data = request.json or {}
    token = (data.get("token") or "").strip()
    hwid = (data.get("hwid") or "").strip()
    name = (data.get("name") or data.get("machine_name") or "MajuBox").strip()

    with get_db() as db:
        m = None
        if token:
            m = db.execute("SELECT * FROM machines WHERE token=?", (token,)).fetchone()
        if not m and hwid:
            m = db.execute("SELECT * FROM machines WHERE hwid=?", (hwid,)).fetchone()

        # Auto cadastro se não existir
        if not m:
            mid = str(uuid.uuid4())[:8].upper()
            token = secrets.token_hex(16)
            exp = (datetime.now() + timedelta(days=3)).isoformat()
            db.execute(
                "INSERT INTO machines(id,name,location,token,hwid,license_ok,license_exp,admin_pass,pix_key,pix_name,pix_city,mp_token) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (mid, name or f"MajuBox-{mid}", "", token, (hwid or None), 1, exp, data.get("admin_password", "1234"), data.get("pix_key", ""), data.get("pix_name", ""), data.get("pix_city", ""), data.get("mp_token", ""))
            )
            db.commit()
            m = db.execute("SELECT * FROM machines WHERE id=?", (mid,)).fetchone()
        else:
            # Atualiza dados vindos da máquina sem mexer na licença
            updates = []
            vals = []
            for col, key in [("name", "name"), ("admin_pass", "admin_password"), ("pix_key", "pix_key"), ("pix_name", "pix_name"), ("pix_city", "pix_city"), ("mp_token", "mp_token"), ("app_version", "app_version")]:
                if data.get(key) is not None:
                    updates.append(f"{col}=?")
                    vals.append(data.get(key) or "")
            if hwid and not m["hwid"]:
                updates.append("hwid=?")
                vals.append(hwid)
            if updates:
                vals.append(m["id"])
                db.execute(f"UPDATE machines SET {', '.join(updates)} WHERE id=?", vals)
                db.commit()
                m = db.execute("SELECT * FROM machines WHERE id=?", (m["id"],)).fetchone()

        if not m or not m["active"]:
            try:
                if m:
                    db.execute("UPDATE machines SET last_seen=datetime('now'), last_ip=?, last_user_agent=?, last_error=? WHERE id=?",
                               (request.headers.get('X-Forwarded-For', request.remote_addr), request.headers.get('User-Agent', ''), 'Máquina bloqueada ou inativa', m['id']))
                    db.commit()
            except Exception:
                pass
            return jsonify({"ok": False, "error": "Maquina bloqueada ou nao encontrada"}), 403

        # Heartbeat: toda vez que a máquina sincroniza, ela fica online no painel.
        db.execute("UPDATE machines SET last_seen=datetime('now'), last_ip=?, last_user_agent=?, last_error=NULL WHERE id=?",
                   (request.headers.get('X-Forwarded-For', request.remote_addr), request.headers.get('User-Agent', ''), m['id']))
        db.commit()
        m = db.execute("SELECT * FROM machines WHERE id=?", (m["id"],)).fetchone()

        license_ok = bool(m["license_ok"])
        license_exp = m["license_exp"]
        if license_exp:
            try:
                exp_dt = datetime.fromisoformat(license_exp)
                if datetime.now() > exp_dt:
                    db.execute("UPDATE machines SET license_ok=0 WHERE id=?", (m["id"],))
                    db.commit()
                    license_ok = False
            except Exception:
                pass

        genres = [dict(g) for g in db.execute("SELECT * FROM genres ORDER BY sort_order").fetchall()]
        for g in genres:
            songs = [dict(p) for p in db.execute("""
                SELECT p.*, d.name AS dvd_name, d.cover_url AS dvd_cover
                FROM playlists p
                LEFT JOIN dvds d ON d.id = p.dvd_id
                WHERE p.genre_id=?
                ORDER BY COALESCE(d.sort_order, 0), p.sort_order, p.id
            """, (g["id"],)).fetchall()]
            g["playlists"] = songs

        base_url = request.host_url.rstrip("/")
        for g in genres:
            if g.get("cover_url") and str(g["cover_url"]).startswith("/"):
                g["cover_url"] = base_url + g["cover_url"]
            for p in g.get("playlists", []):
                if p.get("dvd_cover") and str(p["dvd_cover"]).startswith("/"):
                    p["dvd_cover"] = base_url + p["dvd_cover"]
                if p.get("cover_url") and str(p["cover_url"]).startswith("/"):
                    p["cover_url"] = base_url + p["cover_url"]

        pix_data = None
        if not license_ok:
            pix_data = _get_or_create_license_pix(m["id"], db)

        return jsonify({
            "ok": True,
            "license_ok": license_ok,
            "license_exp": license_exp,
            "machine_name": m["name"],
            "machine_id": m["id"],
            "token": m["token"],
            "genres": genres,
            "pix": pix_data,
            "machine_pix": {
                "pix_key": m["pix_key"] or "",
                "pix_name": m["pix_name"] or "",
                "pix_city": m["pix_city"] or "",
                "mp_token_configured": bool(m["mp_token"])
            }
        })

# Compatibilidade para apps antigos que ainda chamam /api/proxy/check
@app.route("/api/proxy/check", methods=["POST"])
def proxy_check():
    return machine_check()

@app.route("/machine/register", methods=["POST"])
@app.route("/api/machine/register", methods=["POST"])
def machine_register():
    # O cadastro real é feito no check pelo HWID/token. Mantemos esta rota para Android/app antigo.
    return machine_check()

@app.route("/proxy/register", methods=["POST"])
@app.route("/api/proxy/register", methods=["POST"])
def proxy_register():
    return machine_check()

@app.route("/api/machine/config", methods=["POST"])
def machine_config_save():
    # Salva configurações da máquina sem quebrar se algum campo faltar.
    data = request.json or {}
    token = (data.get("token") or "").strip()
    hwid = (data.get("hwid") or "").strip()
    with get_db() as db:
        m = None
        if token:
            m = db.execute("SELECT * FROM machines WHERE token=?", (token,)).fetchone()
        if not m and hwid:
            m = db.execute("SELECT * FROM machines WHERE hwid=?", (hwid,)).fetchone()
        if not m:
            return jsonify({"ok": False, "error": "Maquina nao encontrada para salvar config"}), 404
        updates=[]; vals=[]
        for col, key in [("name","name"),("admin_pass","admin_password"),("pix_key","pix_key"),("pix_name","pix_name"),("pix_city","pix_city"),("mp_token","mp_token"),("app_version","app_version")]:
            if key in data:
                updates.append(f"{col}=?"); vals.append(data.get(key) or "")
        updates.append("last_seen=datetime('now')")
        updates.append("last_ip=?"); vals.append(request.headers.get('X-Forwarded-For', request.remote_addr))
        updates.append("last_user_agent=?"); vals.append(request.headers.get('User-Agent', ''))
        if updates:
            vals.append(m["id"])
            db.execute(f"UPDATE machines SET {', '.join(updates)} WHERE id=?", vals)
            db.commit()
    return jsonify({"ok": True})

@app.route("/api/proxy/config", methods=["POST"])
def proxy_config_save():
    return machine_config_save()

@app.route("/api/machine/play", methods=["POST"])

def machine_play():
    """Registra música tocada"""
    data = request.json or {}
    token = data.get("token", "")
    with get_db() as db:
        m = db.execute("SELECT id FROM machines WHERE token=?", (token,)).fetchone()
        if m:
            db.execute("UPDATE machines SET last_seen=datetime('now'), last_ip=?, last_user_agent=?, last_error=NULL WHERE id=?",
                       (request.headers.get('X-Forwarded-For', request.remote_addr), request.headers.get('User-Agent', ''), m["id"]))
            db.execute("INSERT INTO plays(machine_id,playlist_id) VALUES(?,?)",
                       (m["id"], data.get("playlist_id")))
            db.commit()
    return jsonify({"ok": True})


@app.route("/api/machine/add_credits", methods=["POST"])
def machine_add_credits():
    """Máquina informa que recebeu créditos (via PIX ou dinheiro)"""
    data = request.json or {}
    token = data.get("token", "")
    amount = data.get("amount", 0)
    credits = data.get("credits", 0)

    with get_db() as db:
        m = db.execute("SELECT id FROM machines WHERE token=?", (token,)).fetchone()
        if m:
            db.execute("UPDATE machines SET last_seen=datetime('now'), last_ip=?, last_user_agent=?, last_error=NULL WHERE id=?",
                       (request.headers.get('X-Forwarded-For', request.remote_addr), request.headers.get('User-Agent', ''), m["id"]))
            db.execute(
                "INSERT INTO machine_revenue_log(machine_id, amount) VALUES(?,?)",
                (m["id"], amount)
            )
            db.commit()

    return jsonify({"ok": True, "credits_added": credits})


@app.route("/api/machine/pix/create", methods=["POST"])
def machine_pix_create():
    """Cria PIX Mercado Pago para comprar créditos da máquina."""
    data = request.json or {}
    token = data.get("token", "")
    try:
        amount = round(float(data.get("amount", 1.0)), 2)
    except Exception:
        amount = 1.0
    amount = max(1.0, amount)
    credits = int(data.get("credits") or round(amount * 2))
    credits = max(1, credits)

    with get_db() as db:
        m = db.execute("SELECT * FROM machines WHERE token=? AND active=1", (token,)).fetchone()
        if not m:
            return jsonify({"ok": False, "error": "Maquina nao encontrada"}), 403

        client_mp_token = (data.get("mp_token") or m["mp_token"] or "").strip()
        if client_mp_token and client_mp_token != (m["mp_token"] or ""):
            db.execute("UPDATE machines SET mp_token=? WHERE id=?", (client_mp_token, m["id"]))
            db.commit()
        if not client_mp_token:
            return jsonify({"ok": False, "error": "Token Mercado Pago do CLIENTE nao configurado na maquina (F1)."}), 400

        payment_id = str(uuid.uuid4())
        pix = create_pix_payment(amount, f"MajuBox - {credits} creditos - {m['name']}", m["id"], access_token=client_mp_token)
        if pix.get("error") or not pix.get("mp_id"):
            return jsonify({"ok": False, "error": pix.get("error", "Erro ao criar PIX no Mercado Pago")}), 400

        db.execute(
            "INSERT INTO payments(id,machine_id,amount,credits,status,pix_qr,pix_code,mp_id,payment_type,credited) VALUES(?,?,?,?,?,?,?,?,?,0)",
            (payment_id, m["id"], amount, credits, "pending", pix["qr_code"], pix["pix_code"], pix["mp_id"], "credits")
        )
        db.commit()

    return jsonify({
        "ok": True,
        "payment_id": payment_id,
        "mp_id": pix["mp_id"],
        "amount": amount,
        "credits": credits,
        "qr_code": pix["qr_code"],
        "pix_code": pix["pix_code"],
        "status": "pending"
    })


@app.route("/api/machine/pix/status", methods=["POST"])
def machine_pix_status():
    """Consulta PIX no Mercado Pago. Quando aprovado, libera crédito uma única vez."""
    data = request.json or {}
    token = data.get("token", "")
    payment_id = data.get("payment_id", "")

    with get_db() as db:
        m = db.execute("SELECT * FROM machines WHERE token=? AND active=1", (token,)).fetchone()
        if not m:
            return jsonify({"ok": False, "error": "Maquina nao encontrada"}), 403

        payment = db.execute(
            "SELECT * FROM payments WHERE id=? AND machine_id=? AND payment_type='credits'",
            (payment_id, m["id"])
        ).fetchone()
        if not payment:
            return jsonify({"ok": False, "error": "Pagamento nao encontrado"}), 404

        client_mp_token = (data.get("mp_token") or m["mp_token"] or "").strip()
        mp_status = check_pix_payment(payment["mp_id"], access_token=client_mp_token) or payment["status"] or "pending"
        credits_added = 0

        if mp_status == "approved":
            if not payment["credited"]:
                credits_added = int(payment["credits"] or 0)
                db.execute(
                    "UPDATE payments SET status='credited', credited=1, paid_at=datetime('now') WHERE id=?",
                    (payment_id,)
                )
                db.execute(
                    "INSERT INTO machine_revenue_log(machine_id, amount) VALUES(?,?)",
                    (m["id"], float(payment["amount"] or 0))
                )
                db.commit()
                return jsonify({
                    "ok": True,
                    "status": "approved",
                    "credited": True,
                    "credits_added": credits_added,
                    "amount": float(payment["amount"] or 0)
                })
            return jsonify({
                "ok": True,
                "status": "approved",
                "credited": True,
                "credits_added": 0,
                "amount": float(payment["amount"] or 0)
            })

        if mp_status in ("rejected", "cancelled", "refunded", "charged_back"):
            db.execute("UPDATE payments SET status=? WHERE id=?", (mp_status, payment_id))
            db.commit()

        return jsonify({
            "ok": True,
            "status": mp_status,
            "credited": bool(payment["credited"]),
            "credits_added": 0,
            "amount": float(payment["amount"] or 0)
        })



# Compatibilidade para apps antigos que ainda chamam /api/proxy/pix...
@app.route("/api/proxy/pix", methods=["POST"])
@app.route("/api/proxy/pix/create", methods=["POST"])
def proxy_pix_create():
    return machine_pix_create()

@app.route("/api/proxy/pix/status", methods=["POST"])
def proxy_pix_status():
    return machine_pix_status()

@app.route("/api/pix/webhook", methods=["POST"])
def pix_webhook():
    """Webhook Mercado Pago — confirma pagamento PIX"""
    data = request.json or {}
    mp_id = str(data.get("data", {}).get("id", ""))

    if not mp_id:
        # Formato alternativo do MP
        mp_id = str(data.get("id", ""))

    if not mp_id:
        return jsonify({"ok": False}), 400

    status = check_pix_payment(mp_id)
    if status != "approved":
        return jsonify({"ok": True, "status": status})

    with get_db() as db:
        payment = db.execute("SELECT * FROM payments WHERE mp_id=?", (mp_id,)).fetchone()
        if payment and payment["status"] != "paid":
            db.execute("UPDATE payments SET status='paid', paid_at=datetime('now') WHERE mp_id=?",
                       (mp_id,))

            if payment["payment_type"] == "credits":
                # A máquina libera os créditos pelo endpoint /api/machine/pix/status.
                # O webhook apenas marca como pago para acelerar a confirmação.
                db.execute("UPDATE payments SET status='paid', paid_at=datetime('now') WHERE mp_id=?", (mp_id,))

            if payment["payment_type"] == "license":
                new_exp = (datetime.now() + timedelta(days=30)).isoformat()
                db.execute("UPDATE machines SET license_ok=1, license_exp=? WHERE id=?",
                           (new_exp, payment["machine_id"]))

                # Registra receita da licença
                month = datetime.now().strftime("%Y-%m")
                existing = db.execute(
                    "SELECT id FROM license_revenue WHERE machine_id=? AND month=?",
                    (payment["machine_id"], month)
                ).fetchone()
                if existing:
                    db.execute("UPDATE license_revenue SET total=total+? WHERE id=?",
                               (payment["amount"], existing["id"]))
                else:
                    db.execute("INSERT INTO license_revenue(machine_id,month,total) VALUES(?,?,?)",
                               (payment["machine_id"], month, payment["amount"]))

            db.commit()

    return jsonify({"ok": True, "status": "paid"})


def _get_or_create_license_pix(machine_id, db):
    """Cria ou recupera PIX pendente para renovação de licença, usando o valor configurado no painel PIX."""
    amount = get_license_price()
    existing = db.execute(
        "SELECT * FROM payments WHERE machine_id=? AND status='pending' AND payment_type='license' ORDER BY created_at DESC LIMIT 1",
        (machine_id,)
    ).fetchone()

    # Se o valor foi alterado no painel, cancela o PIX pendente antigo e cria outro no valor novo.
    if existing and abs(float(existing["amount"] or 0) - float(amount)) > 0.001:
        db.execute("UPDATE payments SET status='cancelled' WHERE id=?", (existing["id"],))
        db.commit()
        existing = None

    if existing:
        return {
            "payment_id": existing["mp_id"],
            "amount": float(existing["amount"] or amount),
            "qr_code": existing["pix_qr"],
            "pix_code": existing["pix_code"],
            "copy_paste": existing["pix_code"],
            "message": f"Licença mensal: R$ {float(existing['amount'] or amount):.2f}. Após aprovado libera por 30 dias."
        }

    payment_id = str(uuid.uuid4())
    pix = create_pix_payment(amount, f"MajuBox - Renovação Licença {machine_id[:8]}", machine_id)
    if not pix.get("ok"):
        return {
            "amount": amount,
            "error": pix.get("error", "Erro ao criar PIX da licença"),
            "message": "Não foi possível gerar PIX. Verifique o token Mercado Pago do servidor."
        }

    db.execute(
        "INSERT INTO payments(id,machine_id,amount,pix_qr,pix_code,mp_id,payment_type,status) VALUES(?,?,?,?,?,?,?,?)",
        (payment_id, machine_id, amount, pix["qr_code"], pix["pix_code"], pix["mp_id"], "license", "pending")
    )
    db.commit()
    return {
        "payment_id": pix["mp_id"],
        "amount": amount,
        "qr_code": pix["qr_code"],
        "pix_code": pix["pix_code"],
        "copy_paste": pix["pix_code"],
        "message": f"Licença mensal: R$ {amount:.2f}. Após aprovado libera por 30 dias."
    }




# ─── Termos de Uso / Contrato de Licença ─────────────────────────────────────
TERMS_VERSION = os.environ.get("TERMS_VERSION", "1.0")

TERMS_TEXT = """TERMOS DE USO E CONTRATO DE LICENÇA MAJUBOX

1. O MajuBox é um sistema de frontend, gerenciamento, organização e reprodução de conteúdos configurados pelo próprio cliente.
2. A licença concede direito de uso do software pelo prazo contratado e não transfere propriedade do código-fonte.
3. O cliente é o único responsável pelos canais, vídeos, músicas, imagens, capas, nomes, marcas, playlists, DVDs, links, chaves de API e conteúdos cadastrados.
4. O cliente declara possuir autorização, licença ou direito legal para usar todo conteúdo inserido no sistema.
5. A fornecedora do MajuBox não fornece músicas, vídeos, filmes, imagens protegidas, canais de terceiros ou conteúdos protegidos.
6. Reclamações, denúncias, notificações ou cobranças por uso indevido de conteúdo serão responsabilidade exclusiva do cliente.
7. O cliente deverá remover imediatamente qualquer conteúdo questionado por terceiros.
8. A licença pode ser mensal, online e vinculada à máquina cadastrada, com validação no servidor.
9. A fornecedora poderá bloquear a licença em caso de falta de pagamento, fraude, violação dos termos ou uso indevido.
10. Ao aceitar eletronicamente, o cliente confirma que leu, entendeu e concorda com estes termos."""

def _find_machine_for_terms(db, token, hwid):
    if token:
        m = db.execute("SELECT * FROM machines WHERE token=?", (token,)).fetchone()
        if m:
            return m
    if hwid:
        m = db.execute("SELECT * FROM machines WHERE hwid=?", (hwid,)).fetchone()
        if m:
            return m
    return None

@app.route("/machine/terms", methods=["GET", "OPTIONS"])
@app.route("/api/machine/terms", methods=["GET", "OPTIONS"])
@app.route("/proxy/terms", methods=["GET", "OPTIONS"])
@app.route("/api/proxy/terms", methods=["GET", "OPTIONS"])
def machine_terms_text():
    if request.method == "OPTIONS":
        return jsonify({"ok": True})
    return jsonify({"ok": True, "terms_version": TERMS_VERSION, "text": TERMS_TEXT})

@app.route("/machine/terms/accept", methods=["POST", "OPTIONS"])
@app.route("/api/machine/terms/accept", methods=["POST", "OPTIONS"])
@app.route("/proxy/terms/accept", methods=["POST", "OPTIONS"])
@app.route("/api/proxy/terms/accept", methods=["POST", "OPTIONS"])
def machine_terms_accept():
    if request.method == "OPTIONS":
        return jsonify({"ok": True})

    data = request.get_json(silent=True) or {}
    hwid = str(data.get("hwid") or "").strip()
    token = str(data.get("token") or "").strip()
    machine_name = str(data.get("machine_name") or data.get("name") or "").strip()
    terms_version = str(data.get("terms_version") or TERMS_VERSION).strip()
    app_version = str(data.get("app_version") or "").strip()
    accepted_at = str(data.get("accepted_at") or datetime.now().isoformat()).strip()
    terms_hash = str(data.get("terms_hash") or ("TERMS_VERSION_" + terms_version)).strip()
    ip = (request.headers.get("X-Forwarded-For") or request.remote_addr or "").split(",")[0].strip()
    user_agent = request.headers.get("User-Agent", "")[:500]

    if not hwid and not token:
        return jsonify({"ok": False, "error": "HWID ou token obrigatório para registrar aceite."}), 400

    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS terms_acceptance (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                machine_id TEXT,
                hwid TEXT,
                token TEXT,
                machine_name TEXT,
                terms_version TEXT,
                app_version TEXT,
                accepted_at TEXT,
                terms_hash TEXT,
                ip TEXT,
                user_agent TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            )
        """)
        m = _find_machine_for_terms(db, token, hwid)
        machine_id = m["id"] if m else ""
        if m and not machine_name:
            machine_name = m["name"] or ""
        db.execute("""
            INSERT INTO terms_acceptance
            (machine_id, hwid, token, machine_name, terms_version, app_version, accepted_at, terms_hash, ip, user_agent)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (machine_id, hwid, token, machine_name, terms_version, app_version, accepted_at, terms_hash, ip, user_agent))
        db.commit()

    return jsonify({
        "ok": True,
        "message": "Termos aceitos e registrados.",
        "terms_version": terms_version,
        "accepted_at": accepted_at
    })


@app.route("/machine/karaoke/score", methods=["POST", "OPTIONS"])
@app.route("/api/machine/karaoke/score", methods=["POST", "OPTIONS"])
@app.route("/proxy/karaoke/score", methods=["POST", "OPTIONS"])
@app.route("/api/proxy/karaoke/score", methods=["POST", "OPTIONS"])
def machine_karaoke_score():
    """Salva pontuação de karaokê enviada pela máquina/web."""
    if request.method == "OPTIONS":
        return jsonify({"ok": True})

    d = request.json or {}
    token = (d.get("token") or "").strip()
    hwid = (d.get("hwid") or "").strip()
    name = (d.get("name") or "CANTOR").strip().upper()[:12]
    song_title = (d.get("song_title") or d.get("song") or "Karaokê").strip()[:200]
    try:
        score = int(d.get("score", 1) or 1)
    except Exception:
        score = 1
    score = max(1, min(99, score))

    with get_db() as db:
        machine = None
        if token:
            machine = db.execute("SELECT id FROM machines WHERE token=?", (token,)).fetchone()
        if not machine and hwid:
            machine = db.execute("SELECT id FROM machines WHERE hwid=?", (hwid,)).fetchone()
        machine_id = machine["id"] if machine else None

        db.execute("""
            INSERT INTO karaoke_scores(machine_id,hwid,token,name,score,song_title)
            VALUES(?,?,?,?,?,?)
        """, (machine_id, hwid, token, name, score, song_title))
        db.commit()

        rows = [dict(r) for r in db.execute("""
            SELECT name, score, song_title, created_at
            FROM karaoke_scores
            WHERE COALESCE(hwid,'')=COALESCE(?, COALESCE(hwid,''))
            ORDER BY score DESC, created_at DESC
            LIMIT 10
        """, (hwid,)).fetchall()]

    return jsonify({"ok": True, "ranking": rows})


@app.route("/machine/karaoke/ranking", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/machine/karaoke/ranking", methods=["GET", "POST", "OPTIONS"])
@app.route("/proxy/karaoke/ranking", methods=["GET", "POST", "OPTIONS"])
@app.route("/api/proxy/karaoke/ranking", methods=["GET", "POST", "OPTIONS"])
def machine_karaoke_ranking():
    if request.method == "OPTIONS":
        return jsonify({"ok": True})
    d = request.json or {}
    hwid = (request.args.get("hwid") or d.get("hwid") or "").strip()
    with get_db() as db:
        if hwid:
            rows = [dict(r) for r in db.execute("""
                SELECT name, score, song_title, created_at
                FROM karaoke_scores
                WHERE hwid=?
                ORDER BY score DESC, created_at DESC
                LIMIT 10
            """, (hwid,)).fetchall()]
        else:
            rows = [dict(r) for r in db.execute("""
                SELECT name, score, song_title, created_at
                FROM karaoke_scores
                ORDER BY score DESC, created_at DESC
                LIMIT 10
            """).fetchall()]
    return jsonify({"ok": True, "ranking": rows})



@app.route("/admin/api/karaoke/ranking", methods=["GET"])
def admin_karaoke_ranking():
    err = require_admin()
    if err: return err
    with get_db() as db:
        rows = [dict(r) for r in db.execute("""
            SELECT ks.*, m.name AS machine_name
            FROM karaoke_scores ks
            LEFT JOIN machines m ON m.id=ks.machine_id
            ORDER BY ks.score DESC, ks.created_at DESC
            LIMIT 200
        """).fetchall()]
    return jsonify({"ok": True, "ranking": rows})

@app.route("/admin/api/terms_acceptance", methods=["GET"])
def admin_terms_acceptance():
    err = require_admin()
    if err: return err
    with get_db() as db:
        rows = [dict(r) for r in db.execute("""
            SELECT ta.*, m.name AS current_machine_name
            FROM terms_acceptance ta
            LEFT JOIN machines m ON m.id = ta.machine_id
            ORDER BY ta.created_at DESC
            LIMIT 500
        """).fetchall()]
    return jsonify({"ok": True, "acceptances": rows})

# ─── Painel Admin ─────────────────────────────────────────────────────────────

ADMIN_HTML = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MajuBox — Painel Admin</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
    --bg: #0a0a0f;
    --card: #13131a;
    --border: #1e1e2e;
    --accent: #e50914;
    --text: #eee;
    --muted: #666;
    --green: #2ecc71;
    --yellow: #f1c40f;
    --red: #e74c3c;
}
body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', sans-serif; min-height: 100vh; }

header {
    background: var(--card);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    gap: 12px;
    position: sticky;
    top: 0;
    z-index: 50;
}
header h1 { font-size: 20px; color: var(--accent); }
header span { color: var(--muted); font-size: 13px; }

.wrap { max-width: 1200px; margin: 0 auto; padding: 24px; }

.tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 24px;
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
}
.tab {
    padding: 10px 18px;
    cursor: pointer;
    border: none;
    background: none;
    color: var(--muted);
    font-size: 13px;
    border-bottom: 2px solid transparent;
    transition: .2s;
    white-space: nowrap;
}
.tab.active { color: var(--accent); border-bottom-color: var(--accent); }

.pane { display: none; }
.pane.active { display: block; }

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }

.card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px;
    transition: .2s;
}
.card:hover { border-color: var(--accent); }
.card h3 { font-size: 15px; margin-bottom: 8px; }
.card p { font-size: 13px; color: var(--muted); }
.genre-card { min-height: 245px; }
.genre-cover-img { width: 100%; height: 132px; object-fit: contain; display: block; margin-bottom: 10px; background: #050508; border: 1px solid var(--border); border-radius: 12px; }
.genre-cover-empty { width: 100%; height: 132px; display: flex; align-items: center; justify-content: center; margin-bottom: 10px; background: #050508; border: 1px dashed var(--border); border-radius: 12px; color: var(--muted); font-size: 34px; }

.badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 700;
}
.badge.green { background: #0d2e1a; color: var(--green); }
.badge.red { background: #2e0d0d; color: var(--red); }
.badge.yellow { background: #2e2a0d; color: var(--yellow); }
.badge.blue { background: #0d1a2e; color: #3498db; }
.status-dot { display:inline-block; width:12px; height:12px; border-radius:50%; margin-right:7px; vertical-align:middle; box-shadow:0 0 10px currentColor; }
.status-dot.green { background: var(--green); color: var(--green); }
.status-dot.red { background: var(--red); color: var(--red); }
.muted-small { color: var(--muted); font-size: 11px; }

.btn, button {
    background: var(--accent);
    color: #fff;
    border: none;
    padding: 8px 16px;
    border-radius: 8px;
    cursor: pointer;
    font-size: 13px;
    transition: .2s;
}
.btn:hover { opacity: 0.9; }
.btn-ghost { background: transparent; border: 1px solid var(--border); color: var(--text); }
.btn-green { background: #0d5c2e; }
.btn-red { background: #5c0d0d; }
.btn-sm { font-size: 11px; padding: 4px 10px; }

input, select, textarea {
    background: #1a1a24;
    border: 1px solid var(--border);
    color: var(--text);
    padding: 8px 12px;
    border-radius: 8px;
    font-size: 13px;
    width: 100%;
}
label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 4px; margin-top: 12px; }

.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); font-size: 13px; }
th { color: var(--muted); font-weight: 600; }

.stat {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    text-align: center;
}
.stat .num { font-size: 32px; font-weight: 700; color: var(--accent); }
.stat .lbl { font-size: 12px; color: var(--muted); margin-top: 4px; }

.stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
}

.playlist-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px;
    border-bottom: 1px solid var(--border);
}
.playlist-item img {
    width: 48px;
    height: 48px;
    object-fit: cover;
    border-radius: 6px;
    background: #222;
}

.modal {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.8);
    z-index: 100;
    align-items: center;
    justify-content: center;
}
.modal.open { display: flex; }

.modal-box {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 24px;
    width: 520px;
    max-width: 95vw;
    max-height: 90vh;
    overflow-y: auto;
}
.modal-box h2 { margin-bottom: 16px; font-size: 18px; }

.dvd-card {
    display: flex;
    gap: 12px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 10px;
    margin-bottom: 8px;
    align-items: center;
}
.dvd-card img { width: 60px; height: 60px; border-radius: 8px; object-fit: cover; background: #222; }

.revenue-reset {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-top: 16px;
}

@media (max-width: 700px) {
    .stats-grid { grid-template-columns: 1fr 1fr; }
    .tabs { flex-wrap: nowrap; }
}
</style>
</head>
<body>

<header>
    <div style="font-size:24px">🎵</div>
    <div><h1>MajuBox</h1><span>Painel Administrativo</span></div>
    <div style="margin-left:auto">
        <a href="/admin/logout" style="color:var(--muted);font-size:13px;text-decoration:none">Sair</a>
    </div>
</header>

<div class="wrap">

<!-- ESTATÍSTICAS -->
<div class="stats-grid" id="stats">
    <div class="stat"><div class="num" id="s-machines">-</div><div class="lbl">Máquinas Ativas</div></div>
    <div class="stat"><div class="num" id="s-plays">-</div><div class="lbl">Músicas Tocadas (Hoje)</div></div>
    <div class="stat"><div class="num" id="s-revenue">-</div><div class="lbl">Receita Licenças (Mês)</div></div>
    <div class="stat"><div class="num" id="s-dvds">-</div><div class="lbl">DVDs Cadastrados</div></div>
</div>

<!-- ABAS -->
<div class="tabs">
    <button class="tab active" onclick="showTab('machines')">🖥️ Máquinas</button>
    <button class="tab" onclick="showTab('genres')">🎸 Gêneros</button>
    <button class="tab" onclick="showTab('dvds')">📀 DVDs</button>
    <button class="tab" onclick="showTab('playlists')">🎵 Músicas</button>
    <button class="tab" onclick="showTab('payments')">💰 Pagamentos</button>
    <button class="tab" onclick="showTab('revenue')">📊 Faturamento</button>
    <button class="tab" onclick="showTab('pix')">💳 PIX</button>
</div>

<!-- MÁQUINAS -->
<div id="pane-machines" class="pane active">
    <div class="row" style="margin-bottom:16px">
        <button class="btn" onclick="openModal('modal-machine')">+ Nova Máquina</button>
        <input id="machine-search" placeholder="Buscar máquina por nome, local, ID ou token..." style="width:360px" oninput="loadMachines()">
        <span id="machines-count" style="font-size:12px;color:var(--muted)"></span>
    </div>
    <table>
        <thead><tr><th>Nome</th><th>Status</th><th>Local</th><th>Licença</th><th>Admin Pass</th><th>Token</th><th>Ações</th></tr></thead>
        <tbody id="machines-tbody"></tbody>
    </table>
</div>

<!-- GÊNEROS -->
<div id="pane-genres" class="pane">
    <div class="row" style="margin-bottom:16px">
        <button class="btn" onclick="openModal('modal-genre')">+ Novo Gênero</button>
    </div>
    <div class="grid" id="genres-grid"></div>
</div>

<!-- DVDs -->
<div id="pane-dvds" class="pane">
    <div class="row" style="margin-bottom:16px">
        <select id="dvd-genre-filter" onchange="loadDVDs()" style="width:200px">
            <option value="">Todos os gêneros</option>
        </select>
        <button class="btn" onclick="openModal('modal-dvd')">+ Novo DVD</button>
    </div>
    <div id="dvds-list"></div>
</div>

<!-- PLAYLISTS -->
<div id="pane-playlists" class="pane">
    <div class="row" style="margin-bottom:16px">
        <select id="filter-genre" onchange="loadPlaylists()" style="width:180px">
            <option value="">Todos os gêneros</option>
        </select>
        <select id="filter-dvd" onchange="loadPlaylists()" style="width:180px">
            <option value="">Todos os DVDs</option>
        </select>
        <button class="btn" onclick="openModal('modal-playlist')">+ Adicionar Música</button>
        <button class="btn btn-ghost" onclick="openModal('modal-bulk-playlist')">📋 Adicionar lista do DVD</button>
        <button class="btn btn-ghost" onclick="openModal('modal-youtube-channel')">📺 Importar canal YouTube</button>
    </div>
    <div id="playlists-list"></div>
</div>

<!-- PAGAMENTOS -->
<div id="pane-payments" class="pane">
    <table>
        <thead><tr><th>Máquina</th><th>Tipo</th><th>Valor</th><th>Créditos</th><th>Status</th><th>Data</th><th>Ações</th></tr></thead>
        <tbody id="payments-tbody"></tbody>
    </table>
</div>

<!-- FATURAMENTO -->
<div id="pane-revenue" class="pane">
    <h2 style="margin-bottom:16px">📊 Faturamento por Licença</h2>
    <div class="row" style="margin-bottom:16px">
        <select id="revenue-month" onchange="loadRevenue()" style="width:180px">
        </select>
        <button class="btn" onclick="loadRevenue()">Atualizar</button>
    </div>
    <table>
        <thead><tr><th>Máquina</th><th>Mês</th><th>Total (R$)</th></tr></thead>
        <tbody id="revenue-tbody"></tbody>
    </table>
    <div class="revenue-reset">
        <h3 style="margin-bottom:12px">Zerar Contadores</h3>
        <p style="color:var(--muted);font-size:13px;margin-bottom:12px">
            Zera o registro de faturamento do mês selecionado. Use para iniciar nova contagem mensal.
        </p>
        <div class="row">
            <select id="reset-month" style="width:180px"></select>
            <button class="btn btn-red" onclick="resetRevenue()">🗑️ Zerar Mês</button>
        </div>
    </div>
</div>

<!-- PIX -->
<div id="pane-pix" class="pane">
    <h2 style="margin-bottom:16px">💳 Configuração PIX</h2>
    <div class="card" style="max-width:500px">
        <p style="margin-bottom:16px;color:var(--muted)">
            Configure as informações PIX que aparecerão nas máquinas para recebimento de créditos.
            Os pagamentos são processados via Mercado Pago.
        </p>
        <label>Chave PIX (CPF/CNPJ/Email/Telefone)</label>
        <input id="pix-key" placeholder="Ex: 123.456.789-00">
        <label>Nome do Recebedor</label>
        <input id="pix-name" placeholder="Seu nome ou empresa">
        <label>Cidade</label>
        <input id="pix-city" placeholder="Sua cidade">
        <label>Token Mercado Pago</label>
        <input id="mp-token" type="password" placeholder="APP_USR-...">
        <label>Valor da licença mensal (R$)</label>
        <input id="license-price" type="number" step="0.01" min="0.01" placeholder="Ex: 15.00">
        <p style="color:var(--muted);font-size:12px;margin-top:-8px;margin-bottom:10px">Esse é o valor do PIX de liberação quando a licença da máquina vencer. Ao pagar, libera por 30 dias.</p>
        <hr style="border:0;border-top:1px solid var(--border);margin:18px 0">
        <h3 style="font-size:15px;margin-bottom:6px">📺 YouTube API</h3>
        <p style="color:var(--muted);font-size:12px;margin-bottom:8px">Cole sua chave da YouTube Data API para importar canais automaticamente.</p>
        <label>Chave YouTube API</label>
        <input id="youtube-api-key" type="password" placeholder="AIza...">
        <div class="row" style="margin-top:20px;justify-content:flex-end">
            <button class="btn" onclick="savePixConfig()">💾 Salvar</button>
        </div>
    </div>
    <div id="pix-status" style="margin-top:16px"></div>
</div>

</div>

<!-- ═══ MODAIS ═══ -->

<div class="modal" id="modal-machine">
    <div class="modal-box">
        <h2>🖥️ Nova Máquina</h2>
        <label>Nome da Máquina</label>
        <input id="m-name" placeholder="Ex: MajuBox Bar do João">
        <label>Local / Endereço</label>
        <input id="m-location" placeholder="Ex: Rua das Flores, 123">
        <label>Senha Admin (para faturamento/PIX na máquina)</label>
        <input id="m-pass" placeholder="Ex: 1234" value="1234">
        <div class="row" style="margin-top:20px;justify-content:flex-end">
            <button class="btn btn-ghost" onclick="closeModal('modal-machine')">Cancelar</button>
            <button class="btn" onclick="createMachine()">Criar</button>
        </div>
    </div>
</div>

<div class="modal" id="modal-genre">
    <div class="modal-box">
        <h2>🎸 Novo Gênero</h2>
        <label>Nome do Gênero</label>
        <input id="g-name" placeholder="Ex: Sertanejo">
        <label>URL da Capa (opcional)</label>
        <input id="g-cover" placeholder="https://...">
        <div class="row" style="margin-top:20px;justify-content:flex-end">
            <button class="btn btn-ghost" onclick="closeModal('modal-genre')">Cancelar</button>
            <button class="btn" onclick="createGenre()">Criar</button>
        </div>
    </div>
</div>

<div class="modal" id="modal-genre-cover">
    <div class="modal-box">
        <h2 id="gc-title">Capa do gênero</h2>
        <p style="color:var(--muted);font-size:13px;margin-bottom:10px">Você pode enviar um PNG sem fundo ou colar uma URL de imagem.</p>
        <label>Enviar imagem PNG/JPG/WebP</label>
        <input id="gc-file" type="file" accept="image/png,image/jpeg,image/webp">
        <label>Ou URL da capa</label>
        <input id="gc-url" placeholder="/genre_covers/sertanejo.png ou https://...">
        <div class="row" style="margin-top:20px;justify-content:flex-end">
            <button class="btn btn-ghost" onclick="closeModal('modal-genre-cover')">Cancelar</button>
            <button class="btn" onclick="saveGenreCover()">Salvar capa</button>
        </div>
    </div>
</div>

<div class="modal" id="modal-dvd">
    <div class="modal-box">
        <h2>📀 Novo DVD</h2>
        <label>Gênero</label>
        <select id="d-genre"></select>
        <label>Nome do DVD</label>
        <input id="d-name" placeholder="Ex: Sertanejo 2024">
        <label>URL da Capa do DVD</label>
        <input id="d-cover" placeholder="https://...">
        <div class="row" style="margin-top:20px;justify-content:flex-end">
            <button class="btn btn-ghost" onclick="closeModal('modal-dvd')">Cancelar</button>
            <button class="btn" onclick="createDVD()">Criar</button>
        </div>
    </div>
</div>

<div class="modal" id="modal-playlist">
    <div class="modal-box">
        <h2>🎵 Adicionar Música</h2>
        <label>Gênero</label>
        <select id="p-genre" onchange="updateDVDSelect()"></select>
        <label>DVD</label>
        <select id="p-dvd"><option value="">Sem DVD (genérico)</option></select>
        <label>Título da Música</label>
        <input id="p-title" placeholder="Nome da música">
        <label>Artista</label>
        <input id="p-artist" placeholder="Nome do artista">
        <label>ID do YouTube (ex: dQw4w9WgXcQ)</label>
        <input id="p-ytid" placeholder="Cole apenas o ID do vídeo">
        <label>URL do Vídeo (alternativa ao YouTube)</label>
        <input id="p-vidurl" placeholder="https://...">
        <label>Modo</label>
        <select id="p-mode">
            <option value="jukebox">Jukebox</option>
            <option value="karaoke">Karaokê</option>
        </select>
        <div class="row" style="margin-top:20px;justify-content:flex-end">
            <button class="btn btn-ghost" onclick="closeModal('modal-playlist')">Cancelar</button>
            <button class="btn" onclick="createPlaylist()">Adicionar</button>
        </div>
    </div>
</div>

<div class="modal" id="modal-edit-playlist">
    <div class="modal-box">
        <h2>✏️ Editar Música</h2>
        <input id="e-id" type="hidden">
        <label>Título da Música</label>
        <input id="e-title" placeholder="Nome da música">
        <label>Artista</label>
        <input id="e-artist" placeholder="Nome do artista">
        <label>ID do YouTube salvo</label>
        <input id="e-ytid" placeholder="Ex: dQw4w9WgXcQ">
        <label>URL do Vídeo (opcional)</label>
        <input id="e-vidurl" placeholder="https://www.youtube.com/watch?v=...">
        <label>Modo</label>
        <select id="e-mode">
            <option value="jukebox">Jukebox</option>
            <option value="karaoke">Karaokê</option>
        </select>
        <div style="color:var(--muted);font-size:12px;margin-top:10px">
            Use este campo para corrigir o ID quando o vídeo der erro, mudar de link ou trocar a música.
        </div>
        <div class="row" style="margin-top:20px;justify-content:flex-end">
            <button class="btn btn-ghost" onclick="closeModal('modal-edit-playlist')">Cancelar</button>
            <button class="btn" onclick="saveEditedPlaylist()">Salvar alteração</button>
        </div>
    </div>
</div>

<div class="modal" id="modal-bulk-playlist">
    <div class="modal-box">
        <h2>📋 Adicionar lista do DVD</h2>
        <p style="color:var(--muted);font-size:13px;margin-bottom:12px">
            Cole várias músicas de uma vez. Aceita formato de tabela, exemplo:<br>
            <code>| Tubarões | `10XarNSkw0s` |</code>
        </p>
        <label>Gênero</label>
        <select id="b-genre" onchange="updateBulkDVDSelect()"></select>
        <label>DVD</label>
        <select id="b-dvd"><option value="">Sem DVD (genérico)</option></select>
        <label>Artista padrão</label>
        <input id="b-artist" placeholder="Ex: Diego e Victor Hugo">
        <label>Modo</label>
        <select id="b-mode">
            <option value="jukebox">Jukebox</option>
            <option value="karaoke">Karaokê</option>
        </select>
        <label>Lista de músicas</label>
        <textarea id="b-list" rows="12" placeholder="| Tubarões | `10XarNSkw0s` |
| Facas | `VntVkQRaAS8` |
| Desbloqueado | `eJO62WkGzcU` |"></textarea>
        <div id="bulk-result" style="color:var(--muted);font-size:13px;margin-top:10px"></div>
        <div class="row" style="margin-top:20px;justify-content:flex-end">
            <button class="btn btn-ghost" onclick="closeModal('modal-bulk-playlist')">Cancelar</button>
            <button class="btn" onclick="bulkCreatePlaylists()">Adicionar lista</button>
        </div>
    </div>
</div>

<div class="modal" id="modal-youtube-channel">
    <div class="modal-box">
        <h2>📺 Importar canal do YouTube</h2>
        <p style="color:var(--muted);font-size:13px;margin-bottom:12px">
            Cole o link do canal. O servidor pega os vídeos, descarta Shorts, vídeos menores que 2 minutos e maiores que 7 minutos e cria as músicas automaticamente.
        </p>
        <label>Gênero</label>
        <select id="yc-genre"></select>
        <label>Link do canal ou @handle</label>
        <input id="yc-channel-url" placeholder="Ex: https://www.youtube.com/@DiegoeVictorHugo">
        <label>Nome do DVD (opcional)</label>
        <input id="yc-dvd-name" placeholder="Se vazio, usa o nome do canal">
        <label>Artista padrão (opcional)</label>
        <input id="yc-artist" placeholder="Se vazio, usa o nome do canal">
        <label>Filtro de duração</label>
        <input id="yc-min-minutes" type="number" min="2" max="7" value="2" readonly>
        <label>Máximo de duração em minutos</label>
        <input id="yc-max-minutes" type="number" min="7" max="7" value="7" readonly>
        <label>Quantidade máxima de vídeos</label>
        <input id="yc-max-results" type="number" min="1" max="500" value="50">
        <label>Modo</label>
        <select id="yc-mode">
            <option value="jukebox">Jukebox</option>
            <option value="karaoke">Karaokê</option>
        </select>
        <div id="yc-result" style="color:var(--muted);font-size:13px;margin-top:10px"></div>
        <div class="row" style="margin-top:20px;justify-content:flex-end">
            <button class="btn btn-ghost" onclick="closeModal('modal-youtube-channel')">Cancelar</button>
            <button class="btn" onclick="importYouTubeChannel()">Importar canal</button>
        </div>
    </div>
</div>


<div class="modal" id="modal-machine-reading">
    <div class="modal-box" style="width:760px">
        <h2>📖 Leitura da Máquina</h2>
        <div id="machine-reading-content" style="font-size:13px;color:var(--text)">Carregando...</div>
        <div class="row" style="margin-top:20px;justify-content:flex-end">
            <button class="btn btn-ghost" onclick="closeModal('modal-machine-reading')">Fechar</button>
        </div>
    </div>
</div>


<script>
const API = '';

async function api(path, method = 'GET', body = null) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : null
    };
    const r = await fetch(API + path, opts);
    let data = {};
    try { data = await r.json(); } catch (e) { data = {}; }
    if (!r.ok && !data.error) {
        data.error = 'Erro HTTP ' + r.status + ' em ' + path;
    }
    return data;
}

function showTab(t) {
    const tabs = { machines: 0, genres: 1, dvds: 2, playlists: 3, payments: 4, revenue: 5, pix: 6 };
    document.querySelectorAll('.tab').forEach((b, i) => b.classList.toggle('active', i === tabs[t]));
    document.querySelectorAll('.pane').forEach(p => p.classList.remove('active'));
    document.getElementById('pane-' + t).classList.add('active');

    if (t === 'machines') loadMachines();
    if (t === 'genres') loadGenres();
    if (t === 'dvds') loadDVDs();
    if (t === 'playlists') loadPlaylists();
    if (t === 'payments') loadPayments();
    if (t === 'revenue') loadRevenue();
    if (t === 'pix') loadPixConfig();
}

function openModal(id) {
    // Garante que os selects de gênero/DVD estejam carregados antes de abrir modais
    if (id === 'modal-youtube-channel' || id === 'modal-bulk-playlist' || id === 'modal-playlist' || id === 'modal-dvd') {
        loadGenres();
        loadDVDs();
    }
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
}
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ─── ESTATÍSTICAS ────────────────────────────────────────────────────────────
async function loadStats() {
    const d = await api('/admin/api/stats');
    document.getElementById('s-machines').textContent = d.machines || 0;
    document.getElementById('s-plays').textContent = d.plays || 0;
    document.getElementById('s-revenue').textContent = 'R$' + (d.revenue || 0).toFixed(0);
    document.getElementById('s-dvds').textContent = d.dvds || 0;
}

// ─── MÁQUINAS ────────────────────────────────────────────────────────────────
async function loadMachines() {
    const q = document.getElementById('machine-search') ? document.getElementById('machine-search').value.trim() : '';
    const d = await api('/admin/api/machines' + (q ? ('?q=' + encodeURIComponent(q)) : ''));
    const tb = document.getElementById('machines-tbody');
    const machines = d.machines || [];
    const countEl = document.getElementById('machines-count');
    if (countEl) countEl.textContent = machines.length + ' máquina(s) encontrada(s)';
    if (!machines.length) {
        tb.innerHTML = '<tr><td colspan="7" style="color:var(--muted);padding:20px">Nenhuma máquina encontrada.</td></tr>';
        return;
    }
    tb.innerHTML = machines.map(m => {
        const onlineClass = m.online ? 'green' : 'red';
        const onlineText = m.online ? 'Online' : 'Offline';
        const lastSeen = m.last_seen_label || 'Nunca conectou';
        return `
        <tr>
            <td><strong>${m.name}</strong><br><span style="font-size:11px;color:var(--muted)">ID: ${m.id}</span></td>
            <td><span class="status-dot ${onlineClass}"></span><strong>${onlineText}</strong><br><span class="muted-small">${lastSeen}</span></td>
            <td>${m.location || '-'}</td>
            <td><span class="badge ${m.license_ok ? 'green' : 'red'}">${m.license_ok ? 'Ativa' : 'Vencida'}</span></td>
            <td>${m.admin_pass || '1234'}</td>
            <td style="font-family:monospace;font-size:11px">${(m.token || '').substring(0, 16)}...</td>
            <td>
                <button class="btn btn-sm btn-ghost" onclick="testMachineConnection('${m.id}')">⋯ Testar</button>
                <button class="btn btn-sm btn-ghost" onclick="showMachineReading('${m.id}')">📖 Leitura</button>
                <button class="btn btn-sm btn-ghost" onclick="toggleLicense('${m.id}', ${m.license_ok})">${m.license_ok ? 'Bloquear' : 'Liberar'}</button>
                <button class="btn btn-sm btn-ghost" onclick="copyToken('${m.token}')">📋</button>
                <button class="btn btn-sm btn-ghost" onclick="resetMachinePass('${m.id}')">🔑</button>
            </td>
        </tr>`;
    }).join('');
}

async function testMachineConnection(id) {
    openModal('modal-machine-reading');
    const box = document.getElementById('machine-reading-content');
    box.innerHTML = 'Testando comunicação da máquina...';
    const d = await api('/admin/api/machines/' + id + '/test_connection', 'POST', {});
    if (!d.ok) {
        box.innerHTML = '<p style="color:var(--red)">' + (d.error || 'Erro ao testar.') + '</p>';
        return;
    }
    const statusColor = d.online ? 'var(--green)' : 'var(--red)';
    box.innerHTML = `
        <div class="card" style="margin-bottom:12px">
            <h3><span class="status-dot ${d.online ? 'green' : 'red'}"></span>${d.machine.name} — ${d.online ? 'ONLINE' : 'OFFLINE'}</h3>
            <p><b>Último contato:</b> ${d.last_seen_label || 'Nunca conectou'}</p>
            <p><b>Rota usada pela máquina:</b> /api/machine/check ou /api/proxy/check</p>
            <p><b>IP último contato:</b> ${d.machine.last_ip || '-'}</p>
            <p><b>App/User-Agent:</b> ${d.machine.last_user_agent || '-'}</p>
        </div>
        <h3 style="margin:12px 0 8px;color:${statusColor}">Resultado do teste</h3>
        <p style="color:var(--muted);font-size:13px;margin-bottom:10px">Esse teste verifica o último contato que a máquina fez com o servidor. Para ficar verde, a máquina precisa estar aberta e sincronizando.</p>
        <table><thead><tr><th>Tipo</th><th>Mensagem</th></tr></thead><tbody>
            ${(d.issues || []).map(x => `<tr><td style="color:var(--red)">Erro</td><td>${x}</td></tr>`).join('')}
            ${(d.warnings || []).map(x => `<tr><td style="color:var(--yellow)">Aviso</td><td>${x}</td></tr>`).join('')}
            ${(!d.issues.length && !d.warnings.length) ? '<tr><td style="color:var(--green)">OK</td><td>Nenhum problema encontrado.</td></tr>' : ''}
        </tbody></table>
    `;
}

async function showMachineReading(id) {
    openModal('modal-machine-reading');
    const box = document.getElementById('machine-reading-content');
    box.innerHTML = 'Carregando leitura da máquina...';
    const d = await api('/admin/api/machines/' + id + '/reading');
    if (!d.ok) {
        box.innerHTML = '<p style="color:var(--red)">' + (d.error || 'Erro ao carregar leitura.') + '</p>';
        return;
    }
    const m = d.machine;
    const plays = d.recent_plays || [];
    const pays = d.recent_payments || [];
    box.innerHTML = `
        <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(160px,1fr));margin-bottom:16px">
            <div class="stat"><div class="num">${d.totals.plays_today}</div><div class="lbl">Tocadas Hoje</div></div>
            <div class="stat"><div class="num">${d.totals.plays_total}</div><div class="lbl">Tocadas Total</div></div>
            <div class="stat"><div class="num">R$${Number(d.totals.revenue_month || 0).toFixed(2)}</div><div class="lbl">Receita Mês</div></div>
            <div class="stat"><div class="num">R$${Number(d.totals.revenue_total || 0).toFixed(2)}</div><div class="lbl">Receita Total</div></div>
        </div>
        <div class="card" style="margin-bottom:12px">
            <h3>${m.name}</h3>
            <p><b>ID:</b> ${m.id} &nbsp; <b>Local:</b> ${m.location || '-'} &nbsp; <b>Licença:</b> ${m.license_ok ? 'Ativa' : 'Vencida'}</p>
            <p><b>Vence em:</b> ${m.license_exp || '-'} &nbsp; <b>Senha admin:</b> ${m.admin_pass || '1234'}</p>
            <p><b>Token:</b> <span style="font-family:monospace">${m.token}</span></p>
        </div>
        <h3 style="margin:12px 0 8px">Últimas músicas tocadas</h3>
        <table><thead><tr><th>Data</th><th>Música</th><th>Artista</th><th>DVD</th></tr></thead><tbody>
            ${plays.length ? plays.map(p => `<tr><td>${p.played_at}</td><td>${p.title || '-'}</td><td>${p.artist || '-'}</td><td>${p.dvd_name || '-'}</td></tr>`).join('') : '<tr><td colspan="4" style="color:var(--muted)">Nenhuma música registrada.</td></tr>'}
        </tbody></table>
        <h3 style="margin:16px 0 8px">Últimos pagamentos/créditos</h3>
        <table><thead><tr><th>Data</th><th>Tipo</th><th>Valor</th><th>Créditos</th><th>Status</th></tr></thead><tbody>
            ${pays.length ? pays.map(p => `<tr><td>${p.created_at}</td><td>${p.payment_type}</td><td>R$${Number(p.amount || 0).toFixed(2)}</td><td>${p.credits || 0}</td><td>${p.status}</td></tr>`).join('') : '<tr><td colspan="5" style="color:var(--muted)">Nenhum pagamento registrado.</td></tr>'}
        </tbody></table>
    `;
}

async function createMachine() {
    const r = await api('/admin/api/machines', 'POST', {
        name: document.getElementById('m-name').value,
        location: document.getElementById('m-location').value,
        admin_pass: document.getElementById('m-pass').value || '1234'
    });
    if (r.ok) {
        closeModal('modal-machine');
        loadMachines();
        loadStats();
    } else alert(r.error || 'Erro ao criar');
}

async function toggleLicense(id, cur) {
    await api('/admin/api/machines/' + id + '/license', 'POST', { active: !cur });
    loadMachines();
}

async function resetMachinePass(id) {
    const pass = prompt('Nova senha admin para a máquina:', '1234');
    if (pass) {
        await api('/admin/api/machines/' + id + '/reset_pass', 'POST', { password: pass });
        loadMachines();
    }
}

function copyToken(t) {
    navigator.clipboard.writeText(t).then(() => alert('Token copiado! Cole no config da máquina.'));
}

// ─── GÊNEROS ─────────────────────────────────────────────────────────────────
async function loadGenres() {
    const d = await api('/admin/api/genres');
    const sel = document.getElementById('p-genre');
    const dvdSel = document.getElementById('d-genre');
    const flt = document.getElementById('filter-genre');
    const dvdFlt = document.getElementById('dvd-genre-filter');
    const bulkSel = document.getElementById('b-genre');
    const ycSel = document.getElementById('yc-genre');

    sel.innerHTML = '<option value="">Selecione</option>';
    dvdSel.innerHTML = '<option value="">Selecione</option>';
    flt.innerHTML = '<option value="">Todos os gêneros</option>';
    dvdFlt.innerHTML = '<option value="">Todos os gêneros</option>';
    if (bulkSel) bulkSel.innerHTML = '<option value="">Selecione</option>';
    if (ycSel) ycSel.innerHTML = '<option value="">Selecione</option>';

    document.getElementById('genres-grid').innerHTML = d.genres.map(g => `
        <div class="card genre-card">
            ${g.cover_url ? `<img class="genre-cover-img" src="${g.cover_url}" onerror="this.outerHTML='<div class=\'genre-cover-empty\'>🎸</div>'">` : `<div class="genre-cover-empty">🎸</div>`}
            <h3>🎸 ${g.name}</h3>
            <p>${g.dvd_count || 0} DVDs · ${g.song_count || 0} músicas</p>
            <div class="row" style="margin-top:12px">
                <button class="btn btn-sm btn-ghost" onclick="openGenreCover(${g.id}, '${String(g.name).replace(/'/g, "\\'")}', '${String(g.cover_url || '').replace(/'/g, "\\'")}')">Adicionar capa</button>
                <button class="btn btn-sm btn-ghost" onclick="deleteGenre(${g.id})">Excluir</button>
            </div>
        </div>
    `).join('');

    d.genres.forEach(g => {
        sel.innerHTML += `<option value="${g.id}">${g.name}</option>`;
        dvdSel.innerHTML += `<option value="${g.id}">${g.name}</option>`;
        flt.innerHTML += `<option value="${g.id}">${g.name}</option>`;
        dvdFlt.innerHTML += `<option value="${g.id}">${g.name}</option>`;
        if (bulkSel) bulkSel.innerHTML += `<option value="${g.id}">${g.name}</option>`;
        if (ycSel) ycSel.innerHTML += `<option value="${g.id}">${g.name}</option>`;
    });
}

async function createGenre() {
    const r = await api('/admin/api/genres', 'POST', {
        name: document.getElementById('g-name').value,
        cover_url: document.getElementById('g-cover').value
    });
    if (r.ok) { closeModal('modal-genre'); loadGenres(); }
    else alert(r.error || 'Erro');
}

let editingGenreId = null;
function openGenreCover(id, name, coverUrl) {
    editingGenreId = id;
    document.getElementById('gc-title').textContent = 'Capa do gênero: ' + name;
    document.getElementById('gc-url').value = coverUrl || '';
    document.getElementById('gc-file').value = '';
    openModal('modal-genre-cover');
}

async function saveGenreCover() {
    if (!editingGenreId) return;
    const form = new FormData();
    form.append('cover_url', document.getElementById('gc-url').value || '');
    const file = document.getElementById('gc-file').files[0];
    if (file) form.append('cover_file', file);

    const r = await fetch('/admin/api/genres/' + editingGenreId + '/cover', {
        method: 'POST',
        body: form
    });
    const d = await r.json();
    if (d.ok) {
        closeModal('modal-genre-cover');
        loadGenres();
        alert('Capa salva! Ela já vai aparecer na máquina depois de reiniciar/conectar.');
    } else {
        alert(d.error || 'Erro ao salvar capa');
    }
}

async function deleteGenre(id) {
    if (confirm('Excluir gênero e TODOS os DVDs e músicas?')) {
        await api('/admin/api/genres/' + id, 'DELETE');
        loadGenres();
    }
}

// ─── DVDs ────────────────────────────────────────────────────────────────────
async function loadDVDs() {
    const gid = document.getElementById('dvd-genre-filter').value;
    const d = await api('/admin/api/dvds' + (gid ? '?genre_id=' + gid : ''));
    const filterDvd = document.getElementById('filter-dvd');
    filterDvd.innerHTML = '<option value="">Todos os DVDs</option>';

    document.getElementById('dvds-list').innerHTML = d.dvds.map(dv => `
        <div class="dvd-card">
            <img src="${dv.cover_url || ''}" onerror="this.style.background='#333'">
            <div style="flex:1">
                <div style="font-weight:600">📀 ${dv.name}</div>
                <div style="font-size:12px;color:var(--muted)">${dv.genre_name || ''} · ${dv.song_count || 0} músicas</div>
            </div>
            <button class="btn btn-sm btn-ghost" onclick="deleteDVD(${dv.id})">Excluir</button>
        </div>
    `).join('') || '<p style="color:var(--muted);padding:20px">Nenhum DVD cadastrado.</p>';

    d.dvds.forEach(dv => {
        filterDvd.innerHTML += `<option value="${dv.id}">${dv.name}</option>`;
    });
}

async function createDVD() {
    const r = await api('/admin/api/dvds', 'POST', {
        genre_id: document.getElementById('d-genre').value,
        name: document.getElementById('d-name').value,
        cover_url: document.getElementById('d-cover').value
    });
    if (r.ok) { closeModal('modal-dvd'); loadDVDs(); loadStats(); }
    else alert(r.error || 'Erro');
}

async function deleteDVD(id) {
    if (confirm('Excluir DVD e todas as músicas?')) {
        await api('/admin/api/dvds/' + id, 'DELETE');
        loadDVDs();
    }
}

function updateDVDSelect() {
    const gid = document.getElementById('p-genre').value;
    const sel = document.getElementById('p-dvd');
    sel.innerHTML = '<option value="">Sem DVD (genérico)</option>';
    if (gid) {
        api('/admin/api/dvds?genre_id=' + gid).then(d => {
            d.dvds.forEach(dv => {
                sel.innerHTML += `<option value="${dv.id}">${dv.name}</option>`;
            });
        });
    }
}


function updateBulkDVDSelect() {
    const gid = document.getElementById('b-genre').value;
    const sel = document.getElementById('b-dvd');
    sel.innerHTML = '<option value="">Sem DVD (genérico)</option>';
    if (gid) {
        api('/admin/api/dvds?genre_id=' + gid).then(d => {
            d.dvds.forEach(dv => {
                sel.innerHTML += `<option value="${dv.id}">${dv.name}</option>`;
            });
        });
    }
}

async function bulkCreatePlaylists() {
    const resultBox = document.getElementById('bulk-result');
    resultBox.textContent = 'Importando...';
    const r = await api('/admin/api/playlists/bulk', 'POST', {
        genre_id: document.getElementById('b-genre').value,
        dvd_id: document.getElementById('b-dvd').value || null,
        artist: document.getElementById('b-artist').value,
        mode: document.getElementById('b-mode').value,
        list_text: document.getElementById('b-list').value
    });
    if (r.ok) {
        resultBox.textContent = `Pronto! ${r.inserted} música(s) adicionada(s). ${r.skipped ? r.skipped + ' linha(s) ignorada(s).' : ''}`;
        document.getElementById('b-list').value = '';
        loadPlaylists();
        loadGenres();
        loadStats();
    } else {
        resultBox.textContent = r.error || 'Erro ao importar lista.';
        alert(r.error || 'Erro ao importar lista.');
    }
}


async function importYouTubeChannel() {
    const resultBox = document.getElementById('yc-result');
    const btns = document.querySelectorAll('#modal-youtube-channel button');
    const genreId = document.getElementById('yc-genre').value;
    const channelUrl = document.getElementById('yc-channel-url').value.trim();
    const dvdName = document.getElementById('yc-dvd-name').value.trim();
    const artist = document.getElementById('yc-artist').value.trim();
    const minMinutes = document.getElementById('yc-min-minutes') ? (document.getElementById('yc-min-minutes').value || '2') : '2';
    const maxMinutes = document.getElementById('yc-max-minutes').value || '7';
    const maxResults = document.getElementById('yc-max-results').value || '50';
    const mode = document.getElementById('yc-mode').value || 'jukebox';

    if (!genreId) {
        resultBox.style.color = '#e74c3c';
        resultBox.textContent = 'Escolha um gênero antes de importar.';
        return;
    }
    if (!channelUrl) {
        resultBox.style.color = '#e74c3c';
        resultBox.textContent = 'Cole o link do canal ou @handle antes de importar.';
        return;
    }

    resultBox.style.color = 'var(--yellow)';
    resultBox.textContent = 'Importando canal... pode demorar alguns segundos. Não feche esta janela.';
    btns.forEach(b => b.disabled = true);

    try {
        const r = await api('/admin/api/youtube/import_channel', 'POST', {
            genre_id: genreId,
            channel_url: channelUrl,
            dvd_name: dvdName,
            artist: artist,
            min_minutes: minMinutes,
            max_minutes: maxMinutes,
            max_results: maxResults,
            mode: mode
        });

        if (r.ok) {
            resultBox.style.color = '#2ecc71';
            resultBox.textContent = `Pronto! DVD "${r.dvd_name}" criado. ${r.inserted} vídeo(s) importado(s), ${r.skipped || 0} ignorado(s) por duração.`;
            await loadDVDs();
            await loadPlaylists();
            await loadGenres();
            await loadStats();
            setTimeout(() => closeModal('modal-youtube-channel'), 1800);
        } else {
            resultBox.style.color = '#e74c3c';
            resultBox.textContent = r.error || 'Erro ao importar canal.';
            alert(r.error || 'Erro ao importar canal.');
        }
    } catch (e) {
        resultBox.style.color = '#e74c3c';
        resultBox.textContent = 'Erro no navegador ao chamar o servidor: ' + e;
        alert('Erro no navegador ao chamar o servidor: ' + e);
    } finally {
        btns.forEach(b => b.disabled = false);
    }
}

// ─── PLAYLISTS ───────────────────────────────────────────────────────────────
async function loadPlaylists() {
    const gid = document.getElementById('filter-genre').value;
    const did = document.getElementById('filter-dvd').value;
    let url = '/admin/api/playlists';
    const params = [];
    if (gid) params.push('genre_id=' + gid);
    if (did) params.push('dvd_id=' + did);
    if (params.length) url += '?' + params.join('&');

    const d = await api(url);
    window._playlistsById = {};
    d.playlists.forEach(p => window._playlistsById[p.id] = p);
    document.getElementById('playlists-list').innerHTML = d.playlists.map(p => `
        <div class="playlist-item">
            <img src="https://img.youtube.com/vi/${p.youtube_id}/mqdefault.jpg"
                 onerror="this.style.background='#333'">
            <div style="flex:1">
                <div style="font-weight:600">${String(p.sort_order || '').padStart(3, '0')}. ${p.title}</div>
                <div style="font-size:12px;color:var(--muted)">
                    ${p.artist || ''} · ${p.genre_name || ''} · ${p.dvd_name || 'Sem DVD'} · ID: <code>${p.youtube_id || ''}</code>
                </div>
            </div>
            <span class="badge ${p.mode === 'karaoke' ? 'yellow' : 'green'}">${p.mode === 'karaoke' ? 'Karaokê' : 'Jukebox'}</span>
            <button class="btn btn-sm btn-ghost" onclick="openEditPlaylist(${p.id})">Editar ID</button>
            <button class="btn btn-sm btn-ghost" onclick="deletePlaylist(${p.id})">✕</button>
        </div>
    `).join('') || '<p style="color:var(--muted);padding:20px">Nenhuma música cadastrada.</p>';
}

async function createPlaylist() {
    const r = await api('/admin/api/playlists', 'POST', {
        genre_id: document.getElementById('p-genre').value,
        dvd_id: document.getElementById('p-dvd').value || null,
        title: document.getElementById('p-title').value,
        artist: document.getElementById('p-artist').value,
        youtube_id: document.getElementById('p-ytid').value,
        video_url: document.getElementById('p-vidurl').value,
        mode: document.getElementById('p-mode').value
    });
    if (r.ok) { closeModal('modal-playlist'); loadPlaylists(); }
    else alert(r.error || 'Erro');
}

function openEditPlaylist(id) {
    const p = (window._playlistsById || {})[id];
    if (!p) return alert('Música não encontrada na tela. Atualize a lista.');
    document.getElementById('e-id').value = p.id;
    document.getElementById('e-title').value = p.title || '';
    document.getElementById('e-artist').value = p.artist || '';
    document.getElementById('e-ytid').value = p.youtube_id || '';
    document.getElementById('e-vidurl').value = p.video_url || '';
    document.getElementById('e-mode').value = p.mode || 'jukebox';
    openModal('modal-edit-playlist');
}

async function saveEditedPlaylist() {
    const id = document.getElementById('e-id').value;
    const youtubeId = document.getElementById('e-ytid').value.trim();
    const videoUrl = document.getElementById('e-vidurl').value.trim();
    const r = await api('/admin/api/playlists/' + id, 'PUT', {
        title: document.getElementById('e-title').value.trim(),
        artist: document.getElementById('e-artist').value.trim(),
        youtube_id: youtubeId,
        video_url: videoUrl || (youtubeId ? 'https://www.youtube.com/watch?v=' + youtubeId : ''),
        mode: document.getElementById('e-mode').value
    });
    if (r.ok) {
        closeModal('modal-edit-playlist');
        loadPlaylists();
    } else {
        alert(r.error || 'Erro ao salvar alteração');
    }
}

async function deletePlaylist(id) {
    await api('/admin/api/playlists/' + id, 'DELETE');
    loadPlaylists();
}

// ─── PAGAMENTOS ──────────────────────────────────────────────────────────────
async function loadPayments() {
    const d = await api('/admin/api/payments');
    document.getElementById('payments-tbody').innerHTML = d.payments.map(p => `
        <tr>
            <td>${p.machine_name || p.machine_id}</td>
            <td><span class="badge blue">${p.payment_type || 'license'}</span></td>
            <td>R$ ${(p.amount || 0).toFixed(2)}</td>
            <td>${p.credits || 0}</td>
            <td><span class="badge ${p.status === 'paid' ? 'green' : p.status === 'pending' ? 'yellow' : 'red'}">${p.status}</span></td>
            <td style="font-size:12px">${(p.created_at || '').substring(0, 16)}</td>
            <td>${p.status === 'pending' ? `<button class="btn btn-sm btn-ghost" onclick="manualPay('${p.id}')">Confirmar</button>` : '–'}</td>
        </tr>
    `).join('') || '<tr><td colspan=7 style="color:var(--muted);padding:20px">Nenhum pagamento.</td></tr>';
}

async function manualPay(id) {
    await api('/admin/api/payments/' + id + '/confirm', 'POST');
    loadPayments();
    loadMachines();
}

// ─── FATURAMENTO ─────────────────────────────────────────────────────────────
function populateMonthSelects() {
    const months = [];
    const now = new Date();
    for (let i = 0; i < 12; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const val = d.toISOString().substring(0, 7);
        const label = d.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
        months.push({ val, label });
    }
    document.getElementById('revenue-month').innerHTML = months.map(m => `<option value="${m.val}">${m.label}</option>`).join('');
    document.getElementById('reset-month').innerHTML = months.map(m => `<option value="${m.val}">${m.label}</option>`).join('');
}

async function loadRevenue() {
    const month = document.getElementById('revenue-month').value;
    const d = await api('/admin/api/revenue?month=' + month);
    document.getElementById('revenue-tbody').innerHTML = d.revenue.map(r => `
        <tr>
            <td>${r.machine_name || r.machine_id}</td>
            <td>${r.month}</td>
            <td><strong>R$ ${(r.total || 0).toFixed(2)}</strong></td>
        </tr>
    `).join('') || '<tr><td colspan=3 style="color:var(--muted);padding:20px">Nenhum registro.</td></tr>';
}

async function resetRevenue() {
    const month = document.getElementById('reset-month').value;
    if (confirm('Zerar contadores de faturamento de ' + month + '?')) {
        await api('/admin/api/revenue/reset', 'POST', { month });
        loadRevenue();
        loadStats();
    }
}

// ─── PIX ─────────────────────────────────────────────────────────────────────
async function loadPixConfig() {
    const d = await api('/admin/api/pix_config');
    document.getElementById('pix-key').value = d.pix_key || '';
    document.getElementById('pix-name').value = d.pix_name || '';
    document.getElementById('pix-city').value = d.pix_city || '';
    if (document.getElementById('license-price')) document.getElementById('license-price').value = d.license_price || '10.00';
    if (document.getElementById('youtube-api-key')) document.getElementById('youtube-api-key').value = '';
    document.getElementById('pix-status').innerHTML = d.mp_configured
        ? '<span class="badge green">✓ Mercado Pago configurado</span>'
        : '<span class="badge yellow">⚠ Token MP não configurado</span>';
    document.getElementById('pix-status').innerHTML += ' ' + (d.youtube_configured
        ? '<span class="badge green">✓ YouTube API configurada</span>'
        : '<span class="badge yellow">⚠ YouTube API não configurada</span>');
    document.getElementById('pix-status').innerHTML += ' <span class="badge blue">Licença R$ ' + (d.license_price || '10.00') + ' / 30 dias</span>';
}

async function savePixConfig() {
    const r = await api('/admin/api/pix_config', 'POST', {
        pix_key: document.getElementById('pix-key').value,
        pix_name: document.getElementById('pix-name').value,
        pix_city: document.getElementById('pix-city').value,
        mp_token: document.getElementById('mp-token').value,
        license_price: document.getElementById('license-price') ? document.getElementById('license-price').value : '10.00',
        youtube_api_key: document.getElementById('youtube-api-key') ? document.getElementById('youtube-api-key').value : ''
    });
    if (r.ok) { alert('Configuração PIX salva!'); loadPixConfig(); }
    else alert('Erro ao salvar');
}

// ─── INICIALIZAÇÃO ───────────────────────────────────────────────────────────
loadStats();
loadMachines();
loadGenres();
loadDVDs();
loadPlaylists();
populateMonthSelects();
</script>
</body>
</html>"""


LOGIN_HTML = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<title>MajuBox — Login</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    background: #0a0a0f;
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    font-family: 'Segoe UI', sans-serif;
    color: #eee;
}
.box {
    background: #13131a;
    border: 1px solid #1e1e2e;
    border-radius: 16px;
    padding: 40px;
    width: 360px;
    text-align: center;
}
.logo { font-size: 48px; margin-bottom: 12px; }
.title { font-size: 24px; font-weight: 700; color: #e50914; margin-bottom: 4px; }
.sub { font-size: 13px; color: #666; margin-bottom: 28px; }
input {
    background: #1a1a24;
    border: 1px solid #1e1e2e;
    color: #eee;
    padding: 12px;
    border-radius: 8px;
    width: 100%;
    margin-bottom: 12px;
    font-size: 14px;
}
button {
    background: #e50914;
    color: #fff;
    border: none;
    padding: 12px;
    border-radius: 8px;
    width: 100%;
    font-size: 15px;
    font-weight: 700;
    cursor: pointer;
}
.err { color: #e74c3c; font-size: 13px; margin-bottom: 12px; }
</style>
</head>
<body>
<div class="box">
    <div class="logo">🎵</div>
    <div class="title">MajuBox</div>
    <div class="sub">Painel Administrativo</div>
    {% if error %}<div class="err">{{ error }}</div>{% endif %}
    <form method="POST">
        <input type="password" name="password" placeholder="Senha de acesso" autofocus>
        <button type="submit">Entrar</button>
    </form>
</div>
</body>
</html>"""


# ─── Rotas Admin ──────────────────────────────────────────────────────────────

@app.route("/admin")
@app.route("/admin/")
def admin():
    if not session.get("admin"):
        return redirect("/admin/login")
    return render_template_string(ADMIN_HTML)


@app.route("/admin/login", methods=["GET", "POST"])
def admin_login():
    error = None
    if request.method == "POST":
        if request.form.get("password") == ADMIN_PASSWORD:
            session["admin"] = True
            return redirect("/admin")
        error = "Senha incorreta."
    return render_template_string(LOGIN_HTML, error=error)


@app.route("/admin/logout")
def admin_logout():
    session.clear()
    return redirect("/admin/login")


# ─── Admin API ────────────────────────────────────────────────────────────────

def require_admin():
    if not session.get("admin"):
        return jsonify({}), 403
    return None


@app.route("/admin/api/stats")
def admin_stats():
    err = require_admin()
    if err: return err
    with get_db() as db:
        machines = db.execute("SELECT COUNT(*) FROM machines WHERE active=1 AND license_ok=1").fetchone()[0]
        plays = db.execute("SELECT COUNT(*) FROM plays WHERE date(played_at)=date('now')").fetchone()[0]
        current_month = datetime.now().strftime("%Y-%m")
        revenue = db.execute(
            "SELECT COALESCE(SUM(total),0) FROM license_revenue WHERE month=?",
            (current_month,)
        ).fetchone()[0]
        dvds = db.execute("SELECT COUNT(*) FROM dvds").fetchone()[0]
    return jsonify({"machines": machines, "plays": plays, "revenue": revenue or 0, "dvds": dvds})


@app.route("/admin/api/machines", methods=["GET", "POST"])
def admin_machines():
    err = require_admin()
    if err: return err
    with get_db() as db:
        if request.method == "POST":
            d = request.json
            if not d.get("name"):
                return jsonify({"ok": False, "error": "Nome obrigatório"})
            mid = str(uuid.uuid4())[:8].upper()
            token = hashlib.sha256((mid + str(uuid.uuid4())).encode()).hexdigest()
            exp = (datetime.now() + timedelta(days=30)).isoformat()
            db.execute(
                "INSERT INTO machines(id,name,location,token,license_exp,admin_pass) VALUES(?,?,?,?,?,?)",
                (mid, d["name"], d.get("location", ""), token, exp, d.get("admin_pass", "1234"))
            )
            db.commit()
            return jsonify({"ok": True, "id": mid, "token": token})

        q = (request.args.get("q") or "").strip()
        if q:
            like = f"%{q}%"
            rows = db.execute(
                """SELECT * FROM machines
                   WHERE name LIKE ? OR location LIKE ? OR id LIKE ? OR token LIKE ? OR admin_pass LIKE ? OR COALESCE(hwid,'') LIKE ?
                   ORDER BY created_at DESC""",
                (like, like, like, like, like, like)
            ).fetchall()
        else:
            rows = db.execute(
                "SELECT * FROM machines ORDER BY created_at DESC"
            ).fetchall()
        machines = [_machine_status_dict(m) for m in rows]
        return jsonify({"machines": machines})


@app.route("/admin/api/machines/<mid>/test_connection", methods=["POST", "GET"])
def admin_machine_test_connection(mid):
    """Testa a comunicação pelo último heartbeat recebido da máquina."""
    err = require_admin()
    if err: return err
    with get_db() as db:
        m = db.execute("SELECT * FROM machines WHERE id=?", (mid,)).fetchone()
        if not m:
            return jsonify({"ok": False, "error": "Máquina não encontrada"}), 404
        machine, issues, warnings = _machine_diagnostics(m)
        return jsonify({
            "ok": True,
            "online": machine.get("online"),
            "last_seen": machine.get("last_seen"),
            "last_seen_label": machine.get("last_seen_label"),
            "last_seen_seconds": machine.get("last_seen_seconds"),
            "machine": machine,
            "issues": issues,
            "warnings": warnings,
            "message": "Online" if machine.get("online") else "Offline"
        })

@app.route("/admin/api/machines/<mid>/license", methods=["POST"])
def admin_machine_license(mid):
    err = require_admin()
    if err: return err
    d = request.json
    with get_db() as db:
        active = 1 if d.get("active") else 0
        exp = (datetime.now() + timedelta(days=30)).isoformat() if active else None
        db.execute("UPDATE machines SET license_ok=?, license_exp=? WHERE id=?", (active, exp, mid))
        db.commit()
    return jsonify({"ok": True})


@app.route("/admin/api/machines/<mid>/reset_pass", methods=["POST"])
def admin_machine_reset_pass(mid):
    err = require_admin()
    if err: return err
    d = request.json
    with get_db() as db:
        db.execute("UPDATE machines SET admin_pass=? WHERE id=?", (d.get("password", "1234"), mid))
        db.commit()
    return jsonify({"ok": True})


@app.route("/admin/api/machines/<mid>/reading", methods=["GET"])
def admin_machine_reading(mid):
    """Leitura detalhada de uma máquina para acompanhamento no painel."""
    err = require_admin()
    if err: return err
    current_month = datetime.now().strftime("%Y-%m")
    today = datetime.now().strftime("%Y-%m-%d")
    with get_db() as db:
        m = db.execute("SELECT * FROM machines WHERE id=?", (mid,)).fetchone()
        if not m:
            return jsonify({"ok": False, "error": "Máquina não encontrada"}), 404

        plays_today = db.execute(
            "SELECT COUNT(*) FROM plays WHERE machine_id=? AND date(played_at)=?",
            (mid, today)
        ).fetchone()[0]
        plays_total = db.execute(
            "SELECT COUNT(*) FROM plays WHERE machine_id=?",
            (mid,)
        ).fetchone()[0]
        revenue_total = db.execute(
            "SELECT COALESCE(SUM(amount),0) FROM machine_revenue_log WHERE machine_id=?",
            (mid,)
        ).fetchone()[0] or 0
        revenue_month = db.execute(
            "SELECT COALESCE(SUM(amount),0) FROM machine_revenue_log WHERE machine_id=? AND strftime('%Y-%m', recorded_at)=?",
            (mid, current_month)
        ).fetchone()[0] or 0

        recent_plays = [dict(r) for r in db.execute(
            """SELECT pl.played_at, p.title, p.artist, d.name AS dvd_name
               FROM plays pl
               LEFT JOIN playlists p ON p.id = pl.playlist_id
               LEFT JOIN dvds d ON d.id = p.dvd_id
               WHERE pl.machine_id=?
               ORDER BY pl.played_at DESC
               LIMIT 20""",
            (mid,)
        ).fetchall()]
        recent_payments = [dict(r) for r in db.execute(
            """SELECT created_at, payment_type, amount, credits, status
               FROM payments
               WHERE machine_id=?
               ORDER BY created_at DESC
               LIMIT 20""",
            (mid,)
        ).fetchall()]

        return jsonify({
            "ok": True,
            "machine": dict(m),
            "totals": {
                "plays_today": plays_today,
                "plays_total": plays_total,
                "revenue_total": float(revenue_total),
                "revenue_month": float(revenue_month),
            },
            "recent_plays": recent_plays,
            "recent_payments": recent_payments,
        })


@app.route("/admin/api/genres", methods=["GET", "POST"])
def admin_genres():
    err = require_admin()
    if err: return err
    with get_db() as db:
        if request.method == "POST":
            d = request.json
            if not d.get("name"):
                return jsonify({"ok": False, "error": "Nome obrigatório"})
            db.execute("INSERT INTO genres(name,cover_url) VALUES(?,?)",
                       (d["name"], d.get("cover_url", "")))
            db.commit()
            return jsonify({"ok": True})

        genres = []
        for g in db.execute("""
            SELECT g.*,
                   COUNT(DISTINCT d.id) as dvd_count,
                   COUNT(DISTINCT p.id) as song_count
            FROM genres g
            LEFT JOIN dvds d ON d.genre_id = g.id
            LEFT JOIN playlists p ON p.genre_id = g.id
            GROUP BY g.id ORDER BY g.sort_order
        """).fetchall():
            genres.append(dict(g))
        return jsonify({"genres": genres})


@app.route("/admin/api/genres/<int:gid>/cover", methods=["POST"])
def admin_genre_cover(gid):
    err = require_admin()
    if err: return err

    cover_url = (request.form.get("cover_url") or "").strip()
    file = request.files.get("cover_file")

    if file and file.filename:
        ext = Path(file.filename).suffix.lower()
        if ext not in (".png", ".jpg", ".jpeg", ".webp"):
            return jsonify({"ok": False, "error": "Use PNG, JPG ou WEBP"}), 400

        safe_name = f"genre_{gid}_{uuid.uuid4().hex[:8]}{ext}"
        target = GENRE_COVERS_DIR / safe_name
        file.save(target)
        cover_url = f"/genre_covers/{safe_name}"

    if not cover_url:
        return jsonify({"ok": False, "error": "Envie uma imagem ou informe uma URL"}), 400

    with get_db() as db:
        db.execute("UPDATE genres SET cover_url=? WHERE id=?", (cover_url, gid))
        db.commit()
    return jsonify({"ok": True, "cover_url": cover_url})


@app.route("/admin/api/genres/<int:gid>", methods=["DELETE"])
def admin_genre_delete(gid):
    err = require_admin()
    if err: return err
    with get_db() as db:
        db.execute("DELETE FROM genres WHERE id=?", (gid,))
        db.commit()
    return jsonify({"ok": True})


@app.route("/admin/api/dvds", methods=["GET", "POST"])
def admin_dvds():
    err = require_admin()
    if err: return err
    with get_db() as db:
        if request.method == "POST":
            d = request.json
            if not d.get("name") or not d.get("genre_id"):
                return jsonify({"ok": False, "error": "Nome e gênero obrigatórios"})
            db.execute("INSERT INTO dvds(genre_id,name,cover_url) VALUES(?,?,?)",
                       (d["genre_id"], d["name"], d.get("cover_url", "")))
            db.commit()
            return jsonify({"ok": True})

        gid = request.args.get("genre_id")
        q = """
            SELECT d.*, g.name as genre_name,
                   COUNT(p.id) as song_count
            FROM dvds d
            LEFT JOIN genres g ON g.id = d.genre_id
            LEFT JOIN playlists p ON p.dvd_id = d.id
        """
        args = ()
        if gid:
            q += " WHERE d.genre_id = ?"
            args = (gid,)
        q += " GROUP BY d.id ORDER BY d.genre_id, d.sort_order"
        dvds = [dict(d) for d in db.execute(q, args).fetchall()]
        return jsonify({"dvds": dvds})


@app.route("/admin/api/dvds/<int:did>", methods=["DELETE"])
def admin_dvd_delete(did):
    err = require_admin()
    if err: return err
    with get_db() as db:
        db.execute("DELETE FROM dvds WHERE id=?", (did,))
        db.commit()
    return jsonify({"ok": True})


@app.route("/admin/api/playlists", methods=["GET", "POST"])
def admin_playlists():
    err = require_admin()
    if err: return err
    with get_db() as db:
        if request.method == "POST":
            d = request.json
            if not d.get("title") or (not d.get("youtube_id") and not d.get("video_url")):
                return jsonify({"ok": False, "error": "Título e vídeo obrigatórios"})
            genre_id = d.get("genre_id")
            dvd_id = d.get("dvd_id")
            next_order = db.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM playlists WHERE genre_id=? AND COALESCE(dvd_id,0)=COALESCE(?,0)", (genre_id, dvd_id)).fetchone()[0] or 1
            db.execute(
                "INSERT INTO playlists(genre_id,dvd_id,title,artist,youtube_id,video_url,mode,sort_order) VALUES(?,?,?,?,?,?,?,?)",
                (genre_id, dvd_id, d["title"], d.get("artist", ""),
                 d.get("youtube_id", ""), d.get("video_url", ""), d.get("mode", "jukebox"), next_order)
            )
            db.commit()
            return jsonify({"ok": True})

        gid = request.args.get("genre_id")
        did = request.args.get("dvd_id")
        q = """
            SELECT p.*, g.name as genre_name, d.name as dvd_name
            FROM playlists p
            LEFT JOIN genres g ON g.id = p.genre_id
            LEFT JOIN dvds d ON d.id = p.dvd_id
        """
        args = []
        if gid:
            q += " WHERE p.genre_id = ?"
            args.append(gid)
        if did:
            q += " WHERE p.dvd_id = ?" if not gid else " AND p.dvd_id = ?"
            args.append(did)
        q += " ORDER BY p.genre_id, p.sort_order"
        playlists = [dict(p) for p in db.execute(q, args).fetchall()]
        return jsonify({"playlists": playlists})



def parse_bulk_playlist_text(text):
    """Aceita linhas tipo: | Música | `youtube_id` |, Música<TAB>ID, Música;ID ou Música,ID."""
    items = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if set(line) <= {"|", "-", ":", " "}:
            continue
        parts = []
        if "|" in line:
            parts = [p.strip().strip("`").strip() for p in line.strip("|").split("|")]
        elif "\t" in line:
            parts = [p.strip().strip("`").strip() for p in line.split("\t")]
        elif ";" in line:
            parts = [p.strip().strip("`").strip() for p in line.split(";")]
        elif "," in line:
            parts = [p.strip().strip("`").strip() for p in line.rsplit(",", 1)]
        else:
            tokens = line.rsplit(None, 1)
            if len(tokens) == 2:
                parts = [tokens[0].strip(), tokens[1].strip().strip("`")]

        parts = [p for p in parts if p]
        if len(parts) < 2:
            continue
        title, youtube_id = parts[0], parts[1]
        # ignora cabeçalho comum
        if title.lower() in {"nome", "música", "musica", "titulo", "título", "title"}:
            continue
        if youtube_id.lower() in {"id", "youtube", "youtube_id"}:
            continue
        items.append({"title": title, "youtube_id": youtube_id})
    return items



def youtube_api_get(path, params):
    """Chama a YouTube Data API v3 usando API key salva no servidor."""
    if not YOUTUBE_API_KEY:
        raise RuntimeError("Chave YouTube API não configurada. Vá em PIX > YouTube API e salve a chave.")
    params = dict(params or {})
    params["key"] = YOUTUBE_API_KEY
    url = "https://www.googleapis.com/youtube/v3/" + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "MajuBox/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        msg = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Erro YouTube API {e.code}: {msg[:300]}")


def iso8601_duration_to_seconds(value):
    """Converte duração ISO 8601 do YouTube, ex: PT3M45S, para segundos."""
    m = re.match(r"^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$", value or "")
    if not m:
        return 0
    h = int(m.group(1) or 0)
    minutes = int(m.group(2) or 0)
    seconds = int(m.group(3) or 0)
    return h * 3600 + minutes * 60 + seconds


def extract_channel_hint(channel_url):
    txt = (channel_url or "").strip()
    if not txt:
        return ""
    if txt.startswith("@"):
        return txt
    try:
        parsed = urllib.parse.urlparse(txt if txt.startswith("http") else "https://" + txt)
        path = parsed.path.strip("/")
        if path.startswith("channel/"):
            return path.split("/", 1)[1].split("/")[0]
        if path.startswith("@"):
            return path.split("/")[0]
        if path.startswith("c/") or path.startswith("user/"):
            return path.split("/", 1)[1].split("/")[0]
        if parsed.netloc:
            return path.split("/")[0] if path else txt
    except Exception:
        pass
    return txt


def resolve_youtube_channel(channel_url):
    """Resolve link/@handle/nome para dados do canal e playlist de uploads."""
    hint = extract_channel_hint(channel_url)
    if not hint:
        raise RuntimeError("Informe o link do canal ou @handle.")

    channel_id = None
    # Canal direto UC...
    if hint.startswith("UC") and len(hint) >= 20:
        channel_id = hint
    else:
        query = hint[1:] if hint.startswith("@") else hint
        data = youtube_api_get("search", {"part": "snippet", "type": "channel", "q": query, "maxResults": 1})
        items = data.get("items", [])
        if not items:
            raise RuntimeError("Canal não encontrado pelo YouTube.")
        channel_id = items[0].get("snippet", {}).get("channelId") or items[0].get("id", {}).get("channelId")

    ch = youtube_api_get("channels", {"part": "snippet,contentDetails", "id": channel_id, "maxResults": 1})
    items = ch.get("items", [])
    if not items:
        raise RuntimeError("Não consegui abrir os dados do canal.")
    item = items[0]
    snippet = item.get("snippet", {})
    uploads = item.get("contentDetails", {}).get("relatedPlaylists", {}).get("uploads")
    if not uploads:
        raise RuntimeError("Não encontrei a playlist de uploads do canal.")
    thumbs = snippet.get("thumbnails", {})
    cover = (thumbs.get("high") or thumbs.get("medium") or thumbs.get("default") or {}).get("url", "")
    return {
        "channel_id": channel_id,
        "title": snippet.get("title", "Canal YouTube"),
        "cover_url": cover,
        "uploads_playlist_id": uploads,
    }


def fetch_channel_videos(uploads_playlist_id, max_results=50):
    """Busca vídeos da playlist de uploads e completa metadados/duração."""
    max_results = max(1, min(int(max_results or 50), 200))
    collected = []
    page_token = None
    while len(collected) < max_results:
        batch_size = min(50, max_results - len(collected))
        params = {"part": "snippet,contentDetails", "playlistId": uploads_playlist_id, "maxResults": batch_size}
        if page_token:
            params["pageToken"] = page_token
        data = youtube_api_get("playlistItems", params)
        for it in data.get("items", []):
            vid = it.get("contentDetails", {}).get("videoId") or it.get("snippet", {}).get("resourceId", {}).get("videoId")
            if vid:
                collected.append({"id": vid, "playlist_snippet": it.get("snippet", {})})
        page_token = data.get("nextPageToken")
        if not page_token:
            break

    result = []
    for i in range(0, len(collected), 50):
        chunk = collected[i:i+50]
        ids = ",".join(v["id"] for v in chunk)
        data = youtube_api_get("videos", {"part": "snippet,contentDetails,status", "id": ids, "maxResults": 50})
        for item in data.get("items", []):
            vid = item.get("id")
            sn = item.get("snippet", {})
            cd = item.get("contentDetails", {})
            thumbs = sn.get("thumbnails", {})
            cover = (thumbs.get("maxres") or thumbs.get("high") or thumbs.get("medium") or thumbs.get("default") or {}).get("url", "")
            result.append({
                "youtube_id": vid,
                "title": sn.get("title", vid),
                "duration_seconds": iso8601_duration_to_seconds(cd.get("duration", "")),
                "cover_url": cover,
            })
    return result

@app.route("/admin/api/playlists/bulk", methods=["POST"])
def admin_playlists_bulk():
    err = require_admin()
    if err: return err
    d = request.json or {}
    text = d.get("list_text", "")
    items = parse_bulk_playlist_text(text)
    if not items:
        return jsonify({"ok": False, "error": "Nenhuma música encontrada. Use: | Nome da música | ID do YouTube |"})

    genre_id = d.get("genre_id") or None
    dvd_id = d.get("dvd_id") or None
    artist = d.get("artist", "")
    mode = d.get("mode", "jukebox") or "jukebox"

    with get_db() as db:
        if dvd_id and not genre_id:
            row = db.execute("SELECT genre_id FROM dvds WHERE id=?", (dvd_id,)).fetchone()
            if row:
                genre_id = row["genre_id"]

        if not genre_id:
            return jsonify({"ok": False, "error": "Escolha um gênero antes de importar."})

        inserted = 0
        skipped = 0
        base_order = db.execute("SELECT COALESCE(MAX(sort_order), 0) FROM playlists WHERE genre_id=? AND COALESCE(dvd_id,0)=COALESCE(?,0)", (genre_id, dvd_id)).fetchone()[0] or 0
        for item in items:
            title = item["title"].strip()
            youtube_id = item["youtube_id"].strip()
            if not title or not youtube_id:
                skipped += 1
                continue
            inserted += 1
            db.execute(
                "INSERT INTO playlists(genre_id,dvd_id,title,artist,youtube_id,video_url,mode,sort_order) VALUES(?,?,?,?,?,?,?,?)",
                (genre_id, dvd_id, title, artist, youtube_id, f"https://www.youtube.com/watch?v={youtube_id}", mode, base_order + inserted)
            )
        db.commit()

    return jsonify({"ok": True, "inserted": inserted, "skipped": skipped})




def _absolute_url_for_machine(value):
    """Transforma /genre_covers/... em URL completa para Windows/Android."""
    if not value:
        return ""
    value = str(value)
    if value.startswith("http://") or value.startswith("https://"):
        return value
    if value.startswith("/"):
        return request.host_url.rstrip("/") + value
    return value


def _import_youtube_channel_to_db(genre_id, channel_url, dvd_name_input="", artist_input="", mode="jukebox", min_minutes=2, max_minutes=7, max_results=200):
    """Importa canal do YouTube para um DVD global. Usado pelo painel e pelas máquinas."""
    if not genre_id:
        return {"ok": False, "error": "Escolha um gênero."}
    if not channel_url:
        return {"ok": False, "error": "Informe o link, @handle ou ID do canal."}

    try:
        min_minutes = float(min_minutes or 2)
        max_minutes = float(max_minutes or 7)
        max_results = int(max_results or 200)
    except Exception:
        return {"ok": False, "error": "Limite de minutos ou quantidade inválida."}

    # Regra fixa MajuBox: bloquear Shorts e só aceitar vídeos de 2 a 7 minutos.
    min_minutes = 2.0
    max_minutes = 7.0
    max_results = max(1, min(200, max_results))

    try:
        channel = resolve_youtube_channel(channel_url)
        videos = fetch_channel_videos(channel["uploads_playlist_id"], max_results=max_results)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    min_seconds = YOUTUBE_MIN_SECONDS
    max_seconds = YOUTUBE_MAX_SECONDS
    dvd_name = (dvd_name_input or "").strip() or channel["title"]
    artist = (artist_input or "").strip() or channel["title"]

    with get_db() as db:
        genre = db.execute("SELECT * FROM genres WHERE id=?", (genre_id,)).fetchone()
        if not genre:
            return {"ok": False, "error": "Gênero não encontrado no servidor."}

        # Evita duplicar o mesmo DVD com mesmo nome no mesmo gênero quando a máquina clicar duas vezes.
        existing_dvd = db.execute(
            "SELECT id FROM dvds WHERE genre_id=? AND LOWER(name)=LOWER(?) LIMIT 1",
            (genre_id, dvd_name)
        ).fetchone()
        if existing_dvd:
            dvd_id = existing_dvd["id"]
            db.execute("UPDATE dvds SET cover_url=COALESCE(NULLIF(cover_url,''), ?) WHERE id=?", (channel.get("cover_url", ""), dvd_id))
        else:
            next_dvd_order = db.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM dvds WHERE genre_id=?", (genre_id,)).fetchone()[0] or 1
            cur = db.execute(
                "INSERT INTO dvds(genre_id,name,cover_url,sort_order) VALUES(?,?,?,?)",
                (genre_id, dvd_name, channel.get("cover_url", ""), next_dvd_order)
            )
            dvd_id = cur.lastrowid

        base_order = db.execute(
            "SELECT COALESCE(MAX(sort_order),0) FROM playlists WHERE genre_id=? AND COALESCE(dvd_id,0)=COALESCE(?,0)",
            (genre_id, dvd_id)
        ).fetchone()[0] or 0

        inserted = 0
        skipped = 0
        duplicated = 0
        for video in videos:
            dur = int(video.get("duration_seconds", 0) or 0)
            # Bloqueia Shorts e vídeos fora do intervalo 2–7 minutos.
            if _is_probable_short_video(video):
                skipped += 1
                continue
            youtube_id = video.get("youtube_id", "").strip()
            if not youtube_id:
                skipped += 1
                continue
            # Regra especial para Karaokê: não repetir a mesma música mesmo que venha de outro canal.
            genre_name_norm = str(genre["name"] or "").lower()
            title_norm = _normalize_song_title_for_duplicate(video.get("title", ""))
            if "karaok" in genre_name_norm and title_norm:
                existing_titles = db.execute("SELECT title FROM playlists WHERE genre_id=?", (genre_id,)).fetchall()
                if any(_normalize_song_title_for_duplicate(row["title"]) == title_norm for row in existing_titles):
                    duplicated += 1
                    continue

            exists = db.execute("SELECT id FROM playlists WHERE youtube_id=? AND dvd_id=? LIMIT 1", (youtube_id, dvd_id)).fetchone()
            if exists:
                duplicated += 1
                continue
            genre_row = db.execute("SELECT name FROM genres WHERE id=?", (genre_id,)).fetchone()
            if genre_row and "karaok" in str(genre_row["name"] or "").lower():
                title_norm = _normalize_song_title_for_duplicate(video.get("title", ""))
                existing_titles = db.execute("SELECT title FROM playlists WHERE genre_id=?", (genre_id,)).fetchall()
                if title_norm and any(_normalize_song_title_for_duplicate(row["title"]) == title_norm for row in existing_titles):
                    skipped += 1
                    continue

            inserted += 1
            db.execute(
                "INSERT INTO playlists(genre_id,dvd_id,title,artist,youtube_id,video_url,cover_url,mode,sort_order) VALUES(?,?,?,?,?,?,?,?,?)",
                (genre_id, dvd_id, video["title"], artist, youtube_id, f"https://www.youtube.com/watch?v={youtube_id}", video.get("cover_url", ""), mode, base_order + inserted)
            )
        db.commit()

    return {
        "ok": True,
        "dvd_id": dvd_id,
        "dvd_name": dvd_name,
        "genre_id": genre_id,
        "genre_name": genre["name"],
        "inserted": inserted,
        "skipped": skipped,
        "duplicated": duplicated,
        "min_minutes": 2,
        "max_minutes": 7,
        "shorts_blocked": skipped,
        "channel_title": channel["title"],
        "channel_cover": channel.get("cover_url", ""),
    }


@app.route("/machine/genres", methods=["POST", "GET", "OPTIONS"])
@app.route("/proxy/genres", methods=["POST", "GET", "OPTIONS"])
@app.route("/api/machine/genres", methods=["POST", "GET", "OPTIONS"])
@app.route("/api/proxy/genres", methods=["POST", "GET", "OPTIONS"])
def machine_genres_list():
    """Lista gêneros para a máquina escolher ao adicionar DVD."""
    if request.method == "OPTIONS":
        return jsonify({"ok": True, "genres": []})
    with get_db() as db:
        rows = [dict(r) for r in db.execute("SELECT id,name,cover_url,sort_order FROM genres ORDER BY sort_order,name").fetchall()]
    for g in rows:
        g["cover_url"] = _absolute_url_for_machine(g.get("cover_url"))
    return jsonify({"ok": True, "genres": rows})


@app.route("/machine/youtube/import_channel", methods=["POST", "OPTIONS"])
@app.route("/api/machine/youtube/import_channel", methods=["POST", "OPTIONS"])
def machine_youtube_import_channel():
    if request.method == "OPTIONS":
        return jsonify({"ok": True})
    """Permite que qualquer máquina autorizada adicione um DVD global pelo canal do YouTube.
    Usa a YouTube API key configurada no servidor. O DVD e as músicas ficam salvos no servidor
    e aparecem para todas as máquinas no próximo atualizar/conectar.
    """
    d = request.json or {}
    token = (d.get("token") or "").strip()
    hwid = (d.get("hwid") or "").strip()

    with get_db() as db:
        machine = None
        if token:
            machine = db.execute("SELECT id,active FROM machines WHERE token=?", (token,)).fetchone()
        if not machine and hwid:
            machine = db.execute("SELECT id,active FROM machines WHERE hwid=?", (hwid,)).fetchone()
        if not machine or not machine["active"]:
            return jsonify({"ok": False, "error": "Máquina não autorizada. Salve/conecte no F1 antes de adicionar DVD."}), 403

    result = _import_youtube_channel_to_db(
        genre_id=d.get("genre_id"),
        channel_url=(d.get("channel_url") or d.get("channel_id") or "").strip(),
        dvd_name_input=(d.get("dvd_name") or "").strip(),
        artist_input=(d.get("artist") or "").strip(),
        mode=d.get("mode", "jukebox") or "jukebox",
        min_minutes=d.get("min_minutes", 2),
        max_minutes=d.get("max_minutes", 7),
        max_results=d.get("max_results", 200),
    )
    status = 200 if result.get("ok") else 400
    return jsonify(result), status

# Compatibilidade para app/web que use /api/proxy
@app.route("/proxy/youtube/import_channel", methods=["POST", "OPTIONS"])
@app.route("/api/proxy/youtube/import_channel", methods=["POST", "OPTIONS"])
def proxy_machine_youtube_import_channel():
    return machine_youtube_import_channel()

@app.route("/admin/api/youtube/import_channel", methods=["POST"])
def admin_youtube_import_channel():
    err = require_admin()
    if err: return err
    d = request.json or {}
    genre_id = d.get("genre_id") or None
    channel_url = (d.get("channel_url") or "").strip()
    dvd_name_input = (d.get("dvd_name") or "").strip()
    artist_input = (d.get("artist") or "").strip()
    mode = d.get("mode", "jukebox") or "jukebox"
    try:
        min_minutes = float(d.get("min_minutes", 2) or 2)
        max_minutes = float(d.get("max_minutes", 7) or 7)
        max_results = int(d.get("max_results", 200) or 200)
    except Exception:
        return jsonify({"ok": False, "error": "Limite de minutos ou quantidade inválida."})
    # Regra fixa MajuBox: mínimo 2 e máximo 7 minutos para bloquear Shorts.
    min_minutes = 2.0
    max_minutes = 7.0
    max_results = max(1, min(200, max_results))
    if not genre_id:
        return jsonify({"ok": False, "error": "Escolha um gênero."})
    if not channel_url:
        return jsonify({"ok": False, "error": "Informe o link do canal."})

    try:
        channel = resolve_youtube_channel(channel_url)
        videos = fetch_channel_videos(channel["uploads_playlist_id"], max_results=max_results)
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)})

    min_seconds = YOUTUBE_MIN_SECONDS
    max_seconds = YOUTUBE_MAX_SECONDS
    dvd_name = dvd_name_input or channel["title"]
    artist = artist_input or channel["title"]

    with get_db() as db:
        next_dvd_order = db.execute("SELECT COALESCE(MAX(sort_order),0)+1 FROM dvds WHERE genre_id=?", (genre_id,)).fetchone()[0] or 1
        cur = db.execute(
            "INSERT INTO dvds(genre_id,name,cover_url,sort_order) VALUES(?,?,?,?)",
            (genre_id, dvd_name, channel.get("cover_url", ""), next_dvd_order)
        )
        dvd_id = cur.lastrowid
        base_order = db.execute("SELECT COALESCE(MAX(sort_order),0) FROM playlists WHERE genre_id=? AND COALESCE(dvd_id,0)=COALESCE(?,0)", (genre_id, dvd_id)).fetchone()[0] or 0
        inserted = 0
        skipped = 0
        for video in videos:
            dur = int(video.get("duration_seconds", 0) or 0)
            # Bloqueia Shorts e vídeos fora do intervalo 2–7 minutos.
            if _is_probable_short_video(video):
                skipped += 1
                continue
            inserted += 1
            db.execute(
                "INSERT INTO playlists(genre_id,dvd_id,title,artist,youtube_id,video_url,cover_url,mode,sort_order) VALUES(?,?,?,?,?,?,?,?,?)",
                (genre_id, dvd_id, video["title"], artist, video["youtube_id"], f"https://www.youtube.com/watch?v={video['youtube_id']}", video.get("cover_url", ""), mode, base_order + inserted)
            )
        db.commit()

    return jsonify({"ok": True, "dvd_id": dvd_id, "dvd_name": dvd_name, "inserted": inserted, "skipped": skipped, "channel_title": channel["title"]})


@app.route("/admin/api/playlists/<int:pid>", methods=["DELETE", "PUT"])
def admin_playlist_edit_delete(pid):
    err = require_admin()
    if err: return err
    with get_db() as db:
        if request.method == "PUT":
            d = request.json or {}
            title = (d.get("title") or "").strip()
            youtube_id = (d.get("youtube_id") or "").strip()
            video_url = (d.get("video_url") or "").strip()
            if not title:
                return jsonify({"ok": False, "error": "Título obrigatório"})
            if not youtube_id and not video_url:
                return jsonify({"ok": False, "error": "Informe o ID do YouTube ou a URL do vídeo"})
            if youtube_id and not video_url:
                video_url = f"https://www.youtube.com/watch?v={youtube_id}"
            db.execute(
                "UPDATE playlists SET title=?, artist=?, youtube_id=?, video_url=?, mode=? WHERE id=?",
                (title, d.get("artist", ""), youtube_id, video_url, d.get("mode", "jukebox"), pid)
            )
            db.commit()
            return jsonify({"ok": True})

        db.execute("DELETE FROM playlists WHERE id=?", (pid,))
        db.commit()
    return jsonify({"ok": True})


@app.route("/admin/api/payments")
def admin_payments():
    err = require_admin()
    if err: return err
    with get_db() as db:
        payments = [dict(p) for p in db.execute("""
            SELECT pay.*, m.name as machine_name
            FROM payments pay
            LEFT JOIN machines m ON m.id = pay.machine_id
            ORDER BY pay.created_at DESC LIMIT 200
        """).fetchall()]
        return jsonify({"payments": payments})


@app.route("/admin/api/payments/<pid>/confirm", methods=["POST"])
def admin_payment_confirm(pid):
    err = require_admin()
    if err: return err
    with get_db() as db:
        p = db.execute("SELECT * FROM payments WHERE id=?", (pid,)).fetchone()
        if p:
            db.execute("UPDATE payments SET status='paid', paid_at=datetime('now') WHERE id=?", (pid,))
            if p["payment_type"] == "license":
                exp = (datetime.now() + timedelta(days=30)).isoformat()
                db.execute("UPDATE machines SET license_ok=1, license_exp=? WHERE id=?",
                           (exp, p["machine_id"]))
                month = datetime.now().strftime("%Y-%m")
                existing = db.execute(
                    "SELECT id FROM license_revenue WHERE machine_id=? AND month=?",
                    (p["machine_id"], month)
                ).fetchone()
                if existing:
                    db.execute("UPDATE license_revenue SET total=total+? WHERE id=?",
                               (p["amount"], existing["id"]))
                else:
                    db.execute("INSERT INTO license_revenue(machine_id,month,total) VALUES(?,?,?)",
                               (p["machine_id"], month, p["amount"]))
            db.commit()
    return jsonify({"ok": True})


@app.route("/admin/api/revenue")
def admin_revenue():
    err = require_admin()
    if err: return err
    month = request.args.get("month", datetime.now().strftime("%Y-%m"))
    with get_db() as db:
        revenue = [dict(r) for r in db.execute("""
            SELECT lr.*, m.name as machine_name
            FROM license_revenue lr
            LEFT JOIN machines m ON m.id = lr.machine_id
            WHERE lr.month = ?
            ORDER BY lr.total DESC
        """, (month,)).fetchall()]
        return jsonify({"revenue": revenue})


@app.route("/admin/api/revenue/reset", methods=["POST"])
def admin_revenue_reset():
    err = require_admin()
    if err: return err
    d = request.json
    month = d.get("month", datetime.now().strftime("%Y-%m"))
    with get_db() as db:
        db.execute("DELETE FROM license_revenue WHERE month=?", (month,))
        db.commit()
    return jsonify({"ok": True})


@app.route("/admin/api/pix_config", methods=["GET", "POST"])
def admin_pix_config():
    global MP_ACCESS_TOKEN, YOUTUBE_API_KEY
    err = require_admin()
    if err: return err
    config_path = PIX_CONFIG_PATH

    if request.method == "POST":
        d = request.json
        old_config = {}
        yt_old_config = {}
        if YOUTUBE_CONFIG_PATH.exists():
            try:
                yt_old_config = json.loads(YOUTUBE_CONFIG_PATH.read_text(encoding="utf-8"))
            except Exception:
                yt_old_config = {}
        if config_path.exists():
            try:
                old_config = json.loads(config_path.read_text(encoding="utf-8"))
            except Exception:
                old_config = {}
        license_price = str(d.get("license_price", old_config.get("license_price", "10.00")) or "10.00").replace(",", ".").strip()
        try:
            license_price = f"{max(0.01, float(license_price)):.2f}"
        except Exception:
            license_price = old_config.get("license_price", "10.00")
        config = {
            "pix_key": d.get("pix_key", ""),
            "pix_name": d.get("pix_name", ""),
            "pix_city": d.get("pix_city", ""),
            "mp_token": old_config.get("mp_token", ""),
            "license_price": license_price,
        }
        if d.get("mp_token"):
            MP_ACCESS_TOKEN = d["mp_token"].strip()
            os.environ["MP_ACCESS_TOKEN"] = MP_ACCESS_TOKEN
            config["mp_token"] = MP_ACCESS_TOKEN
        yt_config = {"youtube_api_key": yt_old_config.get("youtube_api_key", "")}
        if d.get("youtube_api_key"):
            YOUTUBE_API_KEY = d["youtube_api_key"].strip()
            os.environ["YOUTUBE_API_KEY"] = YOUTUBE_API_KEY
            yt_config["youtube_api_key"] = YOUTUBE_API_KEY
        YOUTUBE_CONFIG_PATH.write_text(json.dumps(yt_config, indent=2, ensure_ascii=False), encoding="utf-8")
        config_path.write_text(json.dumps(config, indent=2, ensure_ascii=False), encoding="utf-8")
        return jsonify({"ok": True})

    if config_path.exists():
        config = json.loads(config_path.read_text(encoding="utf-8"))
    else:
        config = {"pix_key": "", "pix_name": "", "pix_city": "", "mp_token": "", "license_price": "10.00"}
    if not config.get("license_price"):
        config["license_price"] = "10.00"

    yt_config = {}
    if YOUTUBE_CONFIG_PATH.exists():
        try:
            yt_config = json.loads(YOUTUBE_CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            yt_config = {}
    config["mp_configured"] = bool(MP_ACCESS_TOKEN or config.get("mp_token"))
    config["youtube_configured"] = bool(YOUTUBE_API_KEY or yt_config.get("youtube_api_key"))
    config.pop("mp_token", None)
    return jsonify(config)



@app.errorhandler(404)
def handle_404(e):
    if request.path.startswith('/api/') or request.path.startswith('/machine') or request.path.startswith('/proxy'):
        return jsonify({"ok": False, "error": "Rota não encontrada", "path": request.path}), 404
    return e

@app.errorhandler(500)
def handle_500(e):
    if request.path.startswith('/api/') or request.path.startswith('/machine') or request.path.startswith('/proxy'):
        return jsonify({"ok": False, "error": "Erro interno do servidor", "path": request.path}), 500
    return e

@app.route("/")
def index():
    return redirect("/admin")


if __name__ == "__main__":
    print("=" * 55)
    print("  🎵 MajuBox — Servidor Central")
    print("  📊 Painel Admin: http://localhost:5000/admin")
    print(f"  🔑 Senha admin: {ADMIN_PASSWORD}")
    print("=" * 55)
    print()
    print("  Variáveis de ambiente:")
    print("    ADMIN_PASSWORD  — senha do painel admin")
    print("    MP_ACCESS_TOKEN — token Mercado Pago (PIX)")
    print("=" * 55)
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)), debug=False)