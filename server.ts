import express from "express";
import cors from "cors";
import path from "path";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import { URL } from "url";

// --- YouTube API Helpers ---
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

async function youtubeApiGet(path: string, params: any) {
  if (!YOUTUBE_API_KEY) {
    throw new Error("Chave YouTube API não configurada no servidor (YOUTUBE_API_KEY).");
  }
  const searchParams = new URLSearchParams(params);
  searchParams.set("key", YOUTUBE_API_KEY);
  const url = `https://www.googleapis.com/youtube/v3/${path}?${searchParams.toString()}`;
  const res = await axios.get(url, { headers: { 'User-Agent': 'MajuBox/1.0' } });
  return res.data;
}

function iso8601DurationToSeconds(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || "0");
  const minutes = parseInt(match[2] || "0");
  const seconds = parseInt(match[3] || "0");
  return hours * 3600 + minutes * 60 + seconds;
}

async function resolveYoutubeChannel(channelHint: string) {
  let channelId = "";
  if (channelHint.startsWith("UC") && channelHint.length >= 20) {
    channelId = channelHint;
  } else {
    const query = channelHint.startsWith("@") ? channelHint.substring(1) : channelHint;
    const data = await youtubeApiGet("search", { part: "snippet", type: "channel", q: query, maxResults: 1 });
    if (!data.items?.length) throw new Error("Canal não encontrado no YouTube.");
    channelId = data.items[0].snippet.channelId || data.items[0].id.channelId;
  }

  const ch = await youtubeApiGet("channels", { part: "snippet,contentDetails", id: channelId, maxResults: 1 });
  if (!ch.items?.length) throw new Error("Não foi possível carregar dados do canal.");
  
  const item = ch.items[0];
  const snippet = item.snippet;
  const uploads = item.contentDetails.relatedPlaylists.uploads;
  const thumb = snippet.thumbnails.high?.url || snippet.thumbnails.medium?.url || snippet.thumbnails.default?.url;

  return {
    channel_id: channelId,
    title: snippet.title,
    cover_url: thumb,
    uploads_playlist_id: uploads
  };
}

async function fetchChannelVideos(playlistId: string, maxResults: number = 50) {
  let collected: any[] = [];
  let pageToken = "";
  
  while (collected.length < maxResults) {
    const batchSize = Math.min(50, maxResults - collected.length);
    const params: any = { part: "snippet,contentDetails", playlistId, maxResults: batchSize };
    if (pageToken) params.pageToken = pageToken;
    
    const data = await youtubeApiGet("playlistItems", params);
    for (const it of data.items || []) {
      const vid = it.contentDetails?.videoId || it.snippet?.resourceId?.videoId;
      if (vid) collected.push({ id: vid });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  const result: any[] = [];
  for (let i = 0; i < collected.length; i += 50) {
    const chunk = collected.slice(i, i + 50);
    const ids = chunk.map(v => v.id).join(",");
    const data = await youtubeApiGet("videos", { part: "snippet,contentDetails", id: ids, maxResults: 50 });
    for (const item of data.items || []) {
      const sn = item.snippet;
      const cd = item.contentDetails;
      const thumb = sn.thumbnails.maxres?.url || sn.thumbnails.high?.url || sn.thumbnails.medium?.url;
      result.push({
        youtube_id: item.id,
        title: sn.title,
        duration_seconds: iso8601DurationToSeconds(cd.duration),
        cover_url: thumb
      });
    }
  }
  return result;
}

// --- Database Setup ---
let db: Database;

async function initDb() {
  db = await open({
    filename: path.join(process.cwd(), "majubox.db"),
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      hwid TEXT UNIQUE,
      name TEXT,
      location TEXT,
      token TEXT UNIQUE,
      license_exp TEXT,
      status TEXT DEFAULT 'active',
      admin_pass TEXT DEFAULT '1234',
      pix_key TEXT,
      pix_name TEXT,
      pix_city TEXT,
      mp_token TEXT, -- Token MP do dono da máquina (para créditos)
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS genres (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      cover_url TEXT,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS dvds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      genre_id INTEGER REFERENCES genres(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      cover_url TEXT,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      genre_id INTEGER REFERENCES genres(id) ON DELETE CASCADE,
      dvd_id INTEGER REFERENCES dvds(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      artist TEXT,
      youtube_id TEXT NOT NULL,
      video_url TEXT,
      cover_url TEXT,
      mode TEXT DEFAULT 'jukebox',
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      machine_id TEXT REFERENCES machines(id),
      amount REAL DEFAULT 0,
      credits INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      pix_qr TEXT,
      pix_code TEXT,
      mp_id TEXT,
      payment_type TEXT DEFAULT 'license',
      credited INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      paid_at TEXT
    );

    CREATE TABLE IF NOT EXISTS plays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT,
      playlist_id INTEGER,
      played_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS license_revenue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT REFERENCES machines(id),
      month TEXT NOT NULL,
      total REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS machine_revenue_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id TEXT REFERENCES machines(id),
      amount REAL DEFAULT 0,
      recorded_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  // Default config
  const licensePrice = await db.get("SELECT value FROM config WHERE key = 'license_price'");
  if (!licensePrice) {
    await db.run("INSERT INTO config (key, value) VALUES ('license_price', '15.00')");
  }

  // Default Genres
  const genreCount = await db.get("SELECT COUNT(*) as count FROM genres");
  if (genreCount.count === 0) {
    const defaultGenres = [
      "Sertanejo", "Pagode", "Forró", "Axé", "Funk", "Rock", "Karaokê", "MPB", "Samba", "Pop"
    ];
    for (let i = 0; i < defaultGenres.length; i++) {
      await db.run("INSERT INTO genres (name, sort_order) VALUES (?, ?)", [defaultGenres[i], i]);
    }
  }
}

async function startServer() {
  await initDb();
  
  const app = express();
  const PORT = parseInt(process.env.PORT || "3000", 10);

  app.use(cors());
  app.use(express.json());

  // --- API Routes (Machine) ---

  const handleMachineCheck = async (req, res) => {
    const { hwid, token, name } = req.body;
    
    if (!hwid) return res.status(400).json({ ok: false, error: "Missing HWID" });

    try {
      let machine = await db.get("SELECT * FROM machines WHERE hwid = ?", [hwid]);

      // Auto-Registration
      if (!machine) {
        const id = uuidv4().substring(0, 8).toUpperCase();
        const newToken = crypto.randomBytes(16).toString('hex');
        // Initial license: 3 days free for testing
        const initialExp = new Date();
        initialExp.setDate(initialExp.getDate() + 3); 
        
        await db.run(
          "INSERT INTO machines (id, hwid, name, token, license_exp) VALUES (?, ?, ?, ?, ?)",
          [id, hwid, name || `MajuBox-${id}`, newToken, initialExp.toISOString()]
        );
        machine = await db.get("SELECT * FROM machines WHERE id = ?", [id]);
      } else if (token && machine.token !== token) {
        // Return 200 with error so App can show message
        return res.json({ ok: false, error: "Token inválido para esta máquina. Verifique as configurações." });
      }

      const now = new Date();
      let expDate = new Date(machine.license_exp);

      // Simple payment verification if client provided a pending payment_id
      const { payment_id_to_verify } = req.body;
      const adminToken = process.env.MP_ACCESS_TOKEN;
      
      if (payment_id_to_verify && adminToken) {
        try {
          const checkRes = await axios.get(`https://api.mercadopago.com/v1/payments/${payment_id_to_verify}`, {
            headers: { 'Authorization': `Bearer ${adminToken}` }
          });
          if (checkRes.data.status === 'approved') {
             // Mark as paid and extend license
             await db.run("UPDATE payments SET status = 'paid', paid_at = ? WHERE id = ?", [new Date().toISOString(), payment_id_to_verify]);
             expDate = new Date();
             expDate.setDate(expDate.getDate() + 30);
             await db.run("UPDATE machines SET license_exp = ? WHERE id = ?", [expDate.toISOString(), machine.id]);
          }
        } catch (e) {
          console.error("Erro verifying payment:", e);
        }
      }

      const license_ok = expDate > now;

      // Se a licença estiver vencida, preparamos o PIX de liberação (da MajuBox/Servidor)
      let pix_liberation = null;
      if (!license_ok) {
        const priceConfig = await db.get("SELECT value FROM config WHERE key = 'license_price'");
        const amount = parseFloat(priceConfig.value);

        if (adminToken) {
          try {
            // Check if there's already a pending payment for this machine
            let pendingPayment = await db.get(
              "SELECT * FROM payments WHERE machine_id = ? AND status = 'pending' AND payment_type = 'license' ORDER BY created_at DESC LIMIT 1",
              [machine.id]
            );

            if (!pendingPayment) {
              const mpRes = await axios.post("https://api.mercadopago.com/v1/payments", {
                transaction_amount: amount,
                description: `Liberação MajuBox: ${machine.id}`,
                payment_method_id: "pix",
                payer: { email: "pagamento@majubox.com" }
              }, {
                headers: { 'Authorization': `Bearer ${adminToken}`, 'X-Idempotency-Key': uuidv4() }
              });

              const payId = uuidv4();
              await db.run(
                "INSERT INTO payments (id, machine_id, amount, payment_type, status, mp_id, pix_qr, pix_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                  payId, 
                  machine.id, 
                  amount, 
                  'license', 
                  'pending', 
                  mpRes.data.id.toString(),
                  mpRes.data.point_of_interaction.transaction_data.qr_code_base64,
                  mpRes.data.point_of_interaction.transaction_data.qr_code
                ]
              );
              pendingPayment = await db.get("SELECT * FROM payments WHERE id = ?", [payId]);
            }

            pix_liberation = {
              payment_id: pendingPayment.mp_id,
              qr_code: pendingPayment.pix_qr,
              copy_paste: pendingPayment.pix_code,
              amount: pendingPayment.amount
            };
          } catch (e) {
            console.error("Erro Pix Liberação:", e);
          }
        } else {
          pix_liberation = { amount, message: "Configure MP_ACCESS_TOKEN no servidor." };
        }
      }

      // Sync Content
      const genres = await db.all("SELECT * FROM genres ORDER BY sort_order");
      for (const g of genres) {
        const songs = await db.all(`
          SELECT p.*, d.name AS dvd_name, d.cover_url AS dvd_cover
          FROM playlists p
          LEFT JOIN dvds d ON d.id = p.dvd_id
          WHERE p.genre_id = ?
          ORDER BY COALESCE(d.sort_order, 0), p.sort_order, p.id
        `, [g.id]);
        g.playlists = songs;
      }

      res.json({
        ok: true,
        machine_id: machine.id,
        token: machine.token,
        license_ok,
        license_exp: machine.license_exp,
        pix_liberation,
        genres,
        machine_pix: {
          pix_key: machine.pix_key,
          pix_name: machine.pix_name,
          pix_city: machine.pix_city
        }
      });
    } catch (err) {
      console.error("Sync error:", err);
      res.status(500).json({ ok: false, error: "Database error" });
    }
  };

  app.post("/api/machine/check", handleMachineCheck);
  app.post("/api/proxy/check", handleMachineCheck);

  const handlePixCreate = async (req, res) => {
    const { mp_token, amount, credits, description, token, hwid } = req.body;
    
    if (!mp_token) return res.status(400).json({ ok: false, error: "Token Mercado Pago não configurado na máquina" });

    try {
      const response = await axios.post("https://api.mercadopago.com/v1/payments", {
        transaction_amount: parseFloat(amount),
        description: description || `Créditos JukeBox: ${credits}`,
        payment_method_id: "pix",
        payer: { email: "pagamento@majubox.com" }
      }, {
        headers: {
          'Authorization': `Bearer ${mp_token}`,
          'X-Idempotency-Key': uuidv4()
        }
      });

      const { id, point_of_interaction } = response.data;
      
      // We could track this on our DB too for logs
      if (hwid) {
        const machine = await db.get("SELECT id FROM machines WHERE hwid = ?", [hwid]);
        if (machine) {
          await db.run(
            "INSERT INTO payments (id, machine_id, amount, payment_type, status, mp_id, pix_qr, pix_code, credits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              uuidv4(), 
              machine.id, 
              parseFloat(amount), 
              'credits', 
              'pending', 
              id.toString(),
              point_of_interaction.transaction_data.qr_code_base64,
              point_of_interaction.transaction_data.qr_code,
              credits
            ]
          );
        }
      }

      res.json({
        ok: true,
        payment_id: id,
        qr_code: point_of_interaction.transaction_data.qr_code_base64,
        copy_paste: point_of_interaction.transaction_data.qr_code,
        status: response.data.status
      });
    } catch (error: any) {
      console.error("MP Error:", error.response?.data || error.message);
      res.status(500).json({ ok: false, error: "Erro ao comunicar com Mercado Pago" });
    }
  };

  app.post("/api/machine/pix/create", handlePixCreate);
  app.post("/api/proxy/pix/create", handlePixCreate);

  const handlePixStatus = async (req, res) => {
    const { mp_token, payment_id, hwid } = req.body;
    if (!mp_token || !payment_id) return res.status(400).json({ ok: false, error: "Dados incompletos" });

    try {
      const response = await axios.get(`https://api.mercadopago.com/v1/payments/${payment_id}`, {
        headers: { 'Authorization': `Bearer ${mp_token}` }
      });
      
      const { status, transaction_amount } = response.data;
      const ok = status === 'approved';

      if (ok && hwid) {
        const machine = await db.get("SELECT id FROM machines WHERE hwid = ?", [hwid]);
        if (machine) {
          // Check if already credited in our logs to avoid double credit if app retries
          const log = await db.get("SELECT * FROM payments WHERE mp_id = ? AND status = 'credited'", [payment_id.toString()]);
          if (!log) {
            await db.run("UPDATE payments SET status = 'credited', paid_at = ? WHERE mp_id = ?", [new Date().toISOString(), payment_id.toString()]);
            await db.run("INSERT INTO machine_revenue_log (machine_id, amount) VALUES (?, ?)", [machine.id, parseFloat(transaction_amount)]);
          }
        }
      }

      res.json({ ok: true, status, credited: ok });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: "Erro ao checar status" });
    }
  };

  app.post("/api/machine/pix/status", handlePixStatus);
  app.post("/api/proxy/pix/status", handlePixStatus);

  app.post("/api/machine/play", async (req, res) => {
    const { hwid, playlist_id } = req.body;
    if (hwid) {
      const machine = await db.get("SELECT id FROM machines WHERE hwid = ?", [hwid]);
      if (machine) {
        await db.run("INSERT INTO plays (machine_id, playlist_id) VALUES (?, ?)", [machine.id, playlist_id]);
      }
    }
    res.json({ ok: true });
  });

  // --- Admin API (Manage Content) ---

  // Genres
  app.get("/api/admin/genres", async (req, res) => {
    const genres = await db.all("SELECT * FROM genres ORDER BY sort_order");
    res.json(genres);
  });

  app.post("/api/admin/genres", async (req, res) => {
    const { name, cover_url } = req.body;
    const result = await db.run("INSERT INTO genres (name, cover_url) VALUES (?, ?)", [name, cover_url]);
    res.json({ ok: true, id: result.lastID });
  });

  app.put("/api/admin/genres/:id", async (req, res) => {
    const { name, cover_url, sort_order } = req.body;
    await db.run("UPDATE genres SET name = ?, cover_url = ?, sort_order = ? WHERE id = ?", [name, cover_url, sort_order, req.params.id]);
    res.json({ ok: true });
  });

  app.delete("/api/admin/genres/:id", async (req, res) => {
    await db.run("DELETE FROM genres WHERE id = ?", [req.params.id]);
    res.json({ ok: true });
  });

  // DVDs
  app.get("/api/admin/dvds", async (req, res) => {
    const dvds = await db.all("SELECT * FROM dvds ORDER BY sort_order");
    res.json(dvds);
  });

  app.post("/api/admin/dvds", async (req, res) => {
    const { genre_id, name, cover_url } = req.body;
    const result = await db.run("INSERT INTO dvds (genre_id, name, cover_url) VALUES (?, ?, ?)", [genre_id, name, cover_url]);
    res.json({ ok: true, id: result.lastID });
  });

  // Playlists (Songs)
  app.get("/api/admin/playlists", async (req, res) => {
    const playlists = await db.all("SELECT * FROM playlists ORDER BY sort_order");
    res.json(playlists);
  });

  app.post("/api/admin/playlists", async (req, res) => {
    const { genre_id, dvd_id, title, artist, youtube_id, video_url, cover_url } = req.body;
    const result = await db.run(
      "INSERT INTO playlists (genre_id, dvd_id, title, artist, youtube_id, video_url, cover_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [genre_id, dvd_id, title, artist, youtube_id, video_url, cover_url]
    );
    res.json({ ok: true, id: result.lastID });
  });

  // YouTube Channel Import
  app.post("/api/admin/youtube/import_channel", async (req, res) => {
    const { genre_id, channel_url, dvd_name, artist, max_minutes = 7, max_results = 50, mode = "jukebox" } = req.body;
    
    if (!genre_id || !channel_url) {
      return res.status(400).json({ ok: false, error: "Gênero e Link do canal são obrigatórios." });
    }

    try {
      const channel = await resolveYoutubeChannel(channel_url);
      const videos = await fetchChannelVideos(channel.uploads_playlist_id, max_results);

      const maxSeconds = max_minutes * 60;
      const finalDvdName = dvd_name || channel.title;
      const finalArtist = artist || channel.title;

      // Create DVD
      const dvdOrderRes = await db.get("SELECT COALESCE(MAX(sort_order),0)+1 as next FROM dvds WHERE genre_id=?", [genre_id]);
      const dvdResult = await db.run(
        "INSERT INTO dvds (genre_id, name, cover_url, sort_order) VALUES (?, ?, ?, ?)",
        [genre_id, finalDvdName, channel.cover_url, dvdOrderRes.next]
      );
      const dvdId = dvdResult.lastID;

      let inserted = 0;
      let skipped = 0;

      for (const video of videos) {
        if (video.duration_seconds > maxSeconds) {
          skipped++;
          continue;
        }
        inserted++;
        await db.run(
          "INSERT INTO playlists (genre_id, dvd_id, title, artist, youtube_id, video_url, cover_url, mode, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [genre_id, dvdId, video.title, finalArtist, video.youtube_id, `https://www.youtube.com/watch?v=${video.youtube_id}`, video.cover_url, mode, inserted]
        );
      }

      res.json({ ok: true, dvd_id: dvdId, dvd_name: finalDvdName, inserted, skipped, channel_title: channel.title });
    } catch (e: any) {
      console.error("Youtube Import Error:", e);
      res.status(500).json({ ok: false, error: e.message || "Erro ao importar do YouTube" });
    }
  });

  // Bulk Import Helper (Ported from Python logic)
  app.post("/api/admin/bulk-import", async (req, res) => {
    const { genre_id, dvd_id, artist = "", mode = "jukebox", list_text } = req.body;
    if (!genre_id || !list_text) return res.status(400).json({ ok: false, error: "Dados inválidos" });

    const lines = list_text.split("\n").filter((l: string) => l.trim());
    let inserted = 0;
    
    const lastOrder = await db.get("SELECT COALESCE(MAX(sort_order), 0) as last FROM playlists WHERE genre_id = ? AND COALESCE(dvd_id, 0) = COALESCE(?, 0)", [genre_id, dvd_id]);
    let currentOrder = lastOrder.last;

    for (const line of lines) {
       // Support formats: | Title | youtube_id | OR Title;ID OR Title,ID
       let title = "";
       let yid = "";

       if (line.includes("|")) {
         const parts = line.split("|").map(p => p.trim());
         if (parts.length >= 3) {
            title = parts[1];
            yid = parts[2].replace(/`/g, "");
         }
       } else if (line.includes(";")) {
         const parts = line.split(";").map(p => p.trim());
         title = parts[0]; yid = parts[1];
       } else if (line.includes("\t")) {
         const parts = line.split("\t").map(p => p.trim());
         title = parts[0]; yid = parts[1];
       }

       if (title && yid) {
         currentOrder++;
         await db.run(
           "INSERT INTO playlists (genre_id, dvd_id, title, artist, youtube_id, video_url, mode, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
           [genre_id, dvd_id, title, artist, yid, `https://www.youtube.com/watch?v=${yid}`, mode, currentOrder]
         );
         inserted++;
       }
    }
    res.json({ ok: true, inserted });
  });

  // Stats
  app.get("/api/admin/stats", async (req, res) => {
    try {
      const machines = await db.get("SELECT COUNT(*) as count FROM machines WHERE status='active'");
      const plays = await db.get("SELECT COUNT(*) as count FROM plays WHERE date(played_at) = date('now')");
      const dvds = await db.get("SELECT COUNT(*) as count FROM dvds");
      const month = new Date().toISOString().substring(0, 7);
      const revenue = await db.get("SELECT COALESCE(SUM(total), 0) as total FROM license_revenue WHERE month = ?", [month]);
      
      res.json({
        machines: machines.count,
        plays: plays.count,
        revenue: revenue.total,
        dvds: dvds.count
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: "Erro ao carregar estatísticas" });
    }
  });

  // Revenue
  app.get("/api/admin/revenue", async (req, res) => {
    const month = req.query.month || new Date().toISOString().substring(0, 7);
    const revenue = await db.all(`
      SELECT lr.*, m.name as machine_name
      FROM license_revenue lr
      LEFT JOIN machines m ON m.id = lr.machine_id
      WHERE lr.month = ?
      ORDER BY lr.total DESC
    `, [month]);
    res.json({ revenue });
  });

  // Machines List
  app.get("/api/admin/machines", async (req, res) => {
    const q = req.query.q as string;
    let sql = "SELECT * FROM machines";
    let params: any[] = [];
    if (q) {
      sql += " WHERE name LIKE ? OR location LIKE ? OR id LIKE ? OR token LIKE ?";
      const like = `%${q}%`;
      params = [like, like, like, like];
    }
    sql += " ORDER BY created_at DESC";
    const machines = await db.all(sql, params);
    res.json({ machines });
  });

  // Admin Config
  app.get("/api/admin/config", async (req, res) => {
    try {
      const price = await db.get("SELECT value FROM config WHERE key = 'license_price'");
      res.json({ ok: true, license_price: price?.value });
    } catch (e) {
      res.status(500).json({ ok: false, error: "Database error" });
    }
  });

  app.post("/api/admin/config", async (req, res) => {
    const { license_price } = req.body;
    try {
      if (license_price) {
        await db.run("UPDATE config SET value = ? WHERE key = 'license_price'", [license_price]);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: "Database error" });
    }
  });

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Vite middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`MajuBox Server rodando em http://localhost:${PORT}`);
  });
}

startServer();
