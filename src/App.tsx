import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Music, 
  Play, 
  Square, 
  ListMusic, 
  CreditCard, 
  Settings, 
  ChevronLeft, 
  Plus, 
  Search,
  Lock,
  Disc,
  X,
  RefreshCw,
  Trash2,
  AlertTriangle,
  FileText,
  ShieldCheck
} from 'lucide-react';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { QRCodeSVG } from 'qrcode.react';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

// --- Types ---
interface Song {
  id: string | number;
  title: string;
  artist: string;
  youtube_id?: string;
  video_url?: string;
  url_video?: string;
  youtube_url?: string;
  duration?: string;
}

interface Playlist {
  id: number | string;
  name: string;
  songs: Song[];
  dvd_id?: number | string;
  dvd_name?: string;
  dvd_cover?: string;
  artist?: string;
  cover?: string;
}

interface Genre {
  id: number;
  name: string;
  cover_url?: string;
  playlists: Playlist[];
}

interface SyncData {
  ok: boolean;
  license_ok: boolean;
  license_exp: string;
  pix_liberation?: any;
  token?: string; // For auto-registration
  genres: Genre[];
  error?: string;
}

// --- Persistence Helpers ---
const CONFIG_FILE = 'majubox_config.json';
const TERMS_VERSION = '1.0';
const TERMS_TEXT = `TERMOS DE USO E CONTRATO DE LICENÇA MAJUBOX

1. OBJETO
O MajuBox é um sistema de frontend, gerenciamento, organização e reprodução de conteúdos configurados pelo próprio cliente, usuário, operador ou responsável pela máquina.

2. LICENÇA DE USO
A contratação concede apenas licença de uso do software pelo prazo contratado. Não há venda, cessão ou transferência do código-fonte, marca, identidade visual, banco de dados do servidor ou propriedade intelectual do sistema.

3. CONTEÚDO INSERIDO PELO CLIENTE
O cliente é o único responsável por cadastrar canais, vídeos, músicas, imagens, capas, nomes, marcas, playlists, DVDs, links, chaves de API, chaves PIX, tokens de pagamento e qualquer outro conteúdo usado na máquina.

4. DIREITOS AUTORAIS, IMAGEM E MARCAS
O cliente declara que possui autorização, licença ou direito legal para usar todo conteúdo inserido no sistema. A fornecedora do MajuBox não fornece músicas, vídeos, filmes, imagens protegidas, canais de terceiros ou conteúdos protegidos por direitos autorais.

5. RESPONSABILIDADE DO CLIENTE
Qualquer reclamação, denúncia, notificação, cobrança, bloqueio, processo ou penalidade causada pelo uso de conteúdo sem autorização será de responsabilidade exclusiva do cliente responsável pela máquina.

6. REMOÇÃO DE CONTEÚDO
Caso exista reclamação, denúncia ou notificação sobre uso indevido de conteúdo, o cliente deverá remover imediatamente o conteúdo questionado. A fornecedora poderá bloquear a licença ou o acesso em caso de violação destes termos.

7. PAGAMENTOS E LICENÇA
A licença pode ser mensal, online e vinculada à máquina cadastrada. O sistema pode exigir conexão com o servidor para validar licença, sincronizar dados, gerar PIX, controlar pagamentos e atualizar informações.

8. CHAVES E CONTAS DE TERCEIROS
Quando o cliente cadastrar tokens, chaves de API, Mercado Pago, PIX ou contas de terceiros, o cliente declara ser autorizado a usar tais dados e assume responsabilidade pelo recebimento de pagamentos, tributos e uso dessas integrações.

9. LIMITAÇÃO DE RESPONSABILIDADE
A fornecedora responde apenas pelo funcionamento do software dentro dos limites contratados, não se responsabilizando pelo conteúdo escolhido, cadastrado, reproduzido ou explorado comercialmente pelo cliente.

10. ACEITE ELETRÔNICO
Ao clicar em “Li e aceito”, o cliente confirma que leu, entendeu e concorda com estes Termos de Uso e Contrato de Licença. O aceite poderá ser registrado com HWID, token, nome da máquina, data/hora, IP, versão do app e versão dos termos.`;

const saveConfig = async (data: any) => {
  try {
    if (Capacitor.isNativePlatform()) {
      await Filesystem.writeFile({
        path: CONFIG_FILE,
        data: JSON.stringify(data),
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
    } else {
      localStorage.setItem('MajuBox_Config', JSON.stringify(data));
    }
  } catch (e) {
    console.error('Erro ao salvar config', e);
  }
};

const loadConfig = async (): Promise<any> => {
  try {
    if (Capacitor.isNativePlatform()) {
      const { data } = await Filesystem.readFile({
        path: CONFIG_FILE,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      return JSON.parse(data as string);
    } else {
      const saved = localStorage.getItem('MajuBox_Config');
      return saved ? JSON.parse(saved) : null;
    }
  } catch (e) {
    return null;
  }
};

// --- Helpers ---
const toggleFullscreen = () => {
  if (Capacitor.isNativePlatform()) return;
  
  const doc = document.documentElement as any;
  const isFull = !!(document.fullscreenElement || (document as any).webkitFullscreenElement || (document as any).mozFullScreenElement || (document as any).msFullscreenElement);

  if (!isFull) {
    const requestMethod = doc.requestFullscreen || doc.webkitRequestFullscreen || doc.mozRequestFullScreen || doc.msRequestFullscreen;
    if (requestMethod) {
      requestMethod.call(doc).catch((err: any) => {
        console.log(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    }
  }
};

const normalizeServerBase = (url: string) => {
  let base = (url || 'https://juke-2.onrender.com').trim();
  if (!base.startsWith('http://') && !base.startsWith('https://')) base = 'https://' + base;
  base = base.replace(/\/+$/, '');
  base = base.replace(/\/admin\/login$/i, '').replace(/\/admin$/i, '').replace(/\/api$/i, '');
  return base;
};

// --- Hooks ---
function useDraggableScroll(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let isDown = false;
    let hasDragged = false;
    let startX = 0;
    let startY = 0;
    let scrollLeft = 0;
    let scrollTop = 0;

    const canScroll = () =>
      el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth;

    // Rolar no mouse/trackpad
    const onWheel = (e: WheelEvent) => {
      if (!canScroll()) return;

      const beforeTop = el.scrollTop;
      const beforeLeft = el.scrollLeft;

      el.scrollTop += e.deltaY;
      el.scrollLeft += e.deltaX;

      if (el.scrollTop !== beforeTop || el.scrollLeft !== beforeLeft) {
        e.preventDefault();
      }
    };

    // Arrastar com mouse, sem atrapalhar o clique normal
    const onMouseDown = (e: MouseEvent) => {
      isDown = true;
      hasDragged = false;
      startX = e.pageX;
      startY = e.pageY;
      scrollLeft = el.scrollLeft;
      scrollTop = el.scrollTop;
    };

    const stopMouseDrag = () => {
      isDown = false;
      window.setTimeout(() => {
        hasDragged = false;
      }, 0);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDown) return;

      const walkX = e.pageX - startX;
      const walkY = e.pageY - startY;

      if (Math.abs(walkX) > 4 || Math.abs(walkY) > 4) {
        hasDragged = true;
        el.scrollLeft = scrollLeft - walkX;
        el.scrollTop = scrollTop - walkY;
        e.preventDefault();
      }
    };

    const onClickCapture = (e: MouseEvent) => {
      if (hasDragged) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // Arrastar com dedo no celular/tablet/WebView
    let touchStartX = 0;
    let touchStartY = 0;
    let touchScrollLeft = 0;
    let touchScrollTop = 0;
    let touching = false;

    const onTouchStart = (e: TouchEvent) => {
      if (!e.touches.length) return;
      touching = true;
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
      touchScrollLeft = el.scrollLeft;
      touchScrollTop = el.scrollTop;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!touching || !e.touches.length || !canScroll()) return;

      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;

      el.scrollLeft = touchScrollLeft - dx;
      el.scrollTop = touchScrollTop - dy;

      // Evita o navegador/WebView engolir o gesto e deixa a lista rolar.
      if (Math.abs(dy) > 2 || Math.abs(dx) > 2) {
        e.preventDefault();
      }
    };

    const onTouchEnd = () => {
      touching = false;
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onMouseDown);
    el.addEventListener('mouseleave', stopMouseDrag);
    el.addEventListener('mouseup', stopMouseDrag);
    el.addEventListener('mousemove', onMouseMove);
    el.addEventListener('click', onClickCapture, true);

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('wheel', onWheel as any);
      el.removeEventListener('mousedown', onMouseDown);
      el.removeEventListener('mouseleave', stopMouseDrag);
      el.removeEventListener('mouseup', stopMouseDrag);
      el.removeEventListener('mousemove', onMouseMove);
      el.removeEventListener('click', onClickCapture, true);

      el.removeEventListener('touchstart', onTouchStart as any);
      el.removeEventListener('touchmove', onTouchMove as any);
      el.removeEventListener('touchend', onTouchEnd as any);
      el.removeEventListener('touchcancel', onTouchEnd as any);
    };
  }, [ref]);
}

export default function App() {
  // Persistence / Configuration
  const [isConfigLoaded, setIsConfigLoaded] = useState(false);
  const [serverUrl, setServerUrl] = useState(() => {
    const envUrl = (import.meta as any).env.VITE_SERVER_URL;
    if (envUrl) return envUrl;
    
    // Tenta carregar do localStorage primeiro
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('MajuBox_Config');
      if (saved) {
        try {
          const cfg = JSON.parse(saved);
          if (cfg.serverUrl) return cfg.serverUrl;
        } catch (e) {}
      }
    }
    // O padrão absoluto é sempre o servidor ativo juke-2
    return "https://juke-2.onrender.com/api/";
  });
  const [token, setToken] = useState('');
  const [mpToken, setMpToken] = useState(''); // New: Mercado Pago token for credits
  
  // Local input states for Admin screen to prevent infinite sync loops while typing
  const [serverUrlInput, setServerUrlInput] = useState(serverUrl);
  const [tokenInput, setTokenInput] = useState('');
  const [mpTokenInput, setMpTokenInput] = useState('');
  
  const [licensePrice, setLicensePrice] = useState('');
  const [licenseInfo, setLicenseInfo] = useState<{ ok: boolean; exp: string; pix?: any } | null>(null);
  const [hwid] = useState(() => {
    const saved = localStorage.getItem('MajuBox_HWID');
    if (saved) return saved;
    const newId = Math.random().toString(36).substring(2, 12).toUpperCase();
    localStorage.setItem('MajuBox_HWID', newId);
    return newId;
  });

  // State
  const [screen, setScreen] = useState<'welcome' | 'genres' | 'dvds' | 'songs' | 'playing' | 'queue' | 'pix' | 'admin' | 'locked' | 'reading' | 'karaoke_score'>('welcome');
  const [genres, setGenres] = useState<Genre[]>([]);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [selectedGenre, setSelectedGenre] = useState<Genre | null>(null);
  const [flippingGenreId, setFlippingGenreId] = useState<number | null>(null);
  const [selectedDVD, setSelectedDVD] = useState<Playlist | null>(null);
  const [currentPlaying, setCurrentPlaying] = useState<Song | null>(null);
  const currentPlayingRef = useRef(currentPlaying);
  useEffect(() => {
    currentPlayingRef.current = currentPlaying;
  }, [currentPlaying]);
  const [previewSong, setPreviewSong] = useState<Song | null>(null);
  const [previewTimer, setPreviewTimer] = useState(0);
  const [queue, setQueue] = useState<Song[]>([]);
  const [credits, setCredits] = useState(0);
  // totalRevenue = entradas por PIX. cashRevenue = dinheiro/créditos colocados manualmente na máquina.
  const [totalRevenue, setTotalRevenue] = useState(0);
  const [cashRevenue, setCashRevenue] = useState(0);
  const getTotalRevenue = () => Number((totalRevenue + cashRevenue).toFixed(2));
  const [tapCount, setTapCount] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [pixData, setPixData] = useState<any>(null);
  const [syncError, setSyncError] = useState('');
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [showDebug, setShowDebug] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('MajuBox_TermsAccepted') === 'true' &&
      localStorage.getItem('MajuBox_TermsVersion') === TERMS_VERSION;
  });
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [termsChecked, setTermsChecked] = useState(false);

  // --- Karaoke / Pontuação ---
  const KARAOKE_KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ".split("");
  const [karaokeModeActive, setKaraokeModeActive] = useState(false);
  const karaokeModeActiveRef = useRef(false);
  const [karaokeScore, setKaraokeScore] = useState(0);
  const [karaokeDisplayScore, setKaraokeDisplayScore] = useState(1);
  const [karaokePhase, setKaraokePhase] = useState<'rolling' | 'result' | 'name' | 'saved'>('rolling');
  const [karaokeName, setKaraokeName] = useState("");
  const [karaokeKeyboardIndex, setKaraokeKeyboardIndex] = useState(0);
  const [karaokeRank, setKaraokeRank] = useState<Array<{name: string; score: number; song: string; date: string}>>(() => {
    try {
      return JSON.parse(localStorage.getItem("MajuBox_KaraokeRank") || "[]");
    } catch {
      return [];
    }
  });
  const activeKaraokeSongRef = useRef<Song | null>(null);
  const karaokeFinishLockRef = useRef(false);
  const karaokeReturnTimerRef = useRef<number | null>(null);
  const karaokeResultTimerRef = useRef<number | null>(null);
  const karaokeRollIntervalRef = useRef<number | null>(null);
  const screenRef = useRef(screen);
  const micStreamRef = useRef<MediaStream | null>(null);
  const micAudioContextRef = useRef<AudioContext | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const micRafRef = useRef<number | null>(null);
  const micStatsRef = useRef({ frames: 0, voiceFrames: 0, max: 0, sum: 0, startedAt: 0 });
  const scoringAudioRef = useRef<HTMLAudioElement | null>(null);



  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || (window as any).Capacitor;

  const logDebug = useCallback((msg: string) => {
    console.log(`[DEBUG] ${msg}`);
    setDebugLogs(prev => [new Date().toLocaleTimeString() + ': ' + msg, ...prev].slice(0, 50));
  }, []);

  const playAudioAsset = useCallback((src: string, options?: { loop?: boolean; volume?: number }) => {
    try {
      const audio = new Audio(src);
      audio.loop = !!options?.loop;
      audio.volume = options?.volume ?? 1;
      const playPromise = audio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => logDebug('Som bloqueado pelo navegador: ' + (err?.message || err)));
      }
      return audio;
    } catch (err: any) {
      logDebug('Erro ao tocar som: ' + (err?.message || err));
      return null;
    }
  }, [logDebug]);

  const stopScoringSound = useCallback(() => {
    try {
      if (scoringAudioRef.current) {
        scoringAudioRef.current.pause();
        scoringAudioRef.current.currentTime = 0;
        scoringAudioRef.current = null;
      }
    } catch {}
  }, []);

  const playCreditSound = useCallback(() => {
    playAudioAsset('/sounds/creditos.mp3', { volume: 1 });
  }, [playAudioAsset]);

  const addManualCredits = useCallback((amountCredits = 1) => {
    const creditsToAdd = Math.max(1, Number(amountCredits) || 1);
    const moneyToAdd = creditsToAdd / 2; // regra da máquina: 2 créditos = R$ 1,00
    setCredits(prev => prev + creditsToAdd);
    setCashRevenue(prev => Number((prev + moneyToAdd).toFixed(2)));
    playCreditSound();
    logDebug(`${creditsToAdd} crédito(s) manual(is) inserido(s) = R$ ${moneyToAdd.toFixed(2)}`);
  }, [playCreditSound, logDebug]);

  const recordTermsAcceptance = useCallback(async () => {
    const acceptedAt = new Date().toISOString();
    localStorage.setItem('MajuBox_TermsAccepted', 'true');
    localStorage.setItem('MajuBox_TermsVersion', TERMS_VERSION);
    localStorage.setItem('MajuBox_TermsAcceptedAt', acceptedAt);
    setTermsAccepted(true);
    setShowTermsModal(false);
    setTermsChecked(false);

    try {
      const machineName = localStorage.getItem('MajuBox_MachineName') || `MajuBox-${hwid.substring(0, 6)}`;
      const payload = {
        hwid,
        token,
        machine_name: machineName,
        terms_version: TERMS_VERSION,
        app_version: '1.0',
        accepted_at: acceptedAt,
        terms_hash: 'TERMS_VERSION_' + TERMS_VERSION
      };
      await axios.post(`${normalizeServerBase(serverUrl)}/machine/terms/accept`, payload, {
        timeout: 15000,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
      });
      logDebug('Termos aceitos e sincronizados com o servidor.');
    } catch (e: any) {
      logDebug('Termos aceitos localmente; sincronização com servidor pendente: ' + (e?.message || e));
    }
  }, [hwid, token, serverUrl, logDebug]);

  useEffect(() => {
    if (isConfigLoaded && !termsAccepted) {
      setShowTermsModal(true);
    }
  }, [isConfigLoaded, termsAccepted]);

  // --- API Helper ---
  const api = useMemo(() => ({
    post: async (path: string, data: any) => {
      if (Capacitor.isNativePlatform()) {
        const cleanBase = normalizeServerBase(serverUrl);
        
        let finalUrl = path;
        if (path === '/machine/check') finalUrl = `${cleanBase}/machine/check`;
        else if (path === '/machine/pix/create') finalUrl = `${cleanBase}/machine/pix/create`;
        else if (path === '/machine/pix/status') finalUrl = `${cleanBase}/machine/pix/status`;
        else if (!path.startsWith('http')) finalUrl = `${cleanBase}${path.startsWith('/') ? path : '/' + path}`;

        logDebug(`CapacitorHttp POST: ${finalUrl}`);
        const options = {
          url: finalUrl,
          data,
          headers: { 'Content-Type': 'application/json' },
          connectTimeout: 30000,
          readTimeout: 30000
        };
        const response = await CapacitorHttp.post(options);
        return response;
      } else {
        const cleanBase = normalizeServerBase(serverUrl);
        const finalUrl = path.startsWith('http') ? path : `${cleanBase}${path.startsWith('/') ? path : '/' + path}`;
        logDebug(`Axios POST direto: ${finalUrl}`);
        return await axios.post(finalUrl, data, { 
          timeout: 45000,
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });
      }
    },
    get: async (path: string) => {
      if (Capacitor.isNativePlatform()) {
        const cleanBase = normalizeServerBase(serverUrl);
        let finalUrl = path.startsWith('http') ? path : `${cleanBase}${path.startsWith('/') ? path : '/' + path}`;
        
        logDebug(`CapacitorHttp GET: ${finalUrl}`);
        const options = {
          url: finalUrl,
          connectTimeout: 30000,
          readTimeout: 30000
        };
        const response = await CapacitorHttp.get(options);
        return response;
      } else {
        const cleanBase = normalizeServerBase(serverUrl);
        const finalUrl = path.startsWith('http') ? path : `${cleanBase}${path.startsWith('/') ? path : '/' + path}`;
        logDebug(`Axios GET direto: ${finalUrl}`);
        return await axios.get(finalUrl, { 
          timeout: 45000,
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
        });
      }
    },
    delete: async (path: string) => {
      if (Capacitor.isNativePlatform()) {
        const cleanBase = normalizeServerBase(serverUrl);
        let finalUrl = path.startsWith('http') ? path : `${cleanBase}${path.startsWith('/') ? path : '/' + path}`;
        const options = { url: finalUrl };
        return await CapacitorHttp.delete(options);
      } else {
        const cleanBase = normalizeServerBase(serverUrl);
        const finalUrl = path.startsWith('http') ? path : `${cleanBase}${path.startsWith('/') ? path : '/' + path}`;
        return await axios.delete(finalUrl, { timeout: 15000 });
      }
    },
    put: async (path: string, data: any) => {
      if (Capacitor.isNativePlatform()) {
        const cleanBase = normalizeServerBase(serverUrl);
        let finalUrl = path.startsWith('http') ? path : `${cleanBase}${path.startsWith('/') ? path : '/' + path}`;
        const options = { url: finalUrl, data, headers: { 'Content-Type': 'application/json' }};
        return await CapacitorHttp.put(options);
      } else {
        const cleanBase = normalizeServerBase(serverUrl);
        const finalUrl = path.startsWith('http') ? path : `${cleanBase}${path.startsWith('/') ? path : '/' + path}`;
        return await axios.put(finalUrl, data, { timeout: 15000 });
      }
    }
  }), [logDebug, serverUrl]);

  const getFullUrl = useCallback((path: string) => {
    // No Capacitor, sempre URL completa
    if (Capacitor.isNativePlatform()) {
      const cleanBase = normalizeServerBase(serverUrl);
      let cleanPath = path.startsWith('/') ? path : '/' + path;
      
      // Evita duplicar /api se a base já tiver
      if (cleanBase.endsWith('/api') && cleanPath.startsWith('/api/')) {
        cleanPath = cleanPath.replace('/api', '');
      }
      
      return `${cleanBase}${cleanPath}`;
    }

    if (path.startsWith('http') || path.startsWith('data:')) return path;

    const cleanBase = normalizeServerBase(serverUrl);
    const cleanPath = path.startsWith('/') ? path : '/' + path;
    return `${cleanBase}${cleanPath}`;
  }, [serverUrl]);

  const isKaraokeText = useCallback((value?: string | null) => {
    const n = (value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
    // Aceita Karaoke, Karaokê, Karaok, Karaok� e variações comuns
    return n.includes("karaoke") || n.includes("karaok") || n.includes("kara");
  }, []);

  const isKaraokeGenre = useCallback((genre?: Genre | null) => {
    return isKaraokeText(genre?.name);
  }, [isKaraokeText]);

  const isKaraokeContext = useCallback((song?: Song | null) => {
    return (
      isKaraokeGenre(selectedGenre) ||
      isKaraokeText(selectedDVD?.name) ||
      isKaraokeText(selectedDVD?.dvd_name) ||
      isKaraokeText(song?.title) ||
      isKaraokeText(song?.artist)
    );
  }, [isKaraokeGenre, isKaraokeText, selectedDVD, selectedGenre]);

  const playSimpleTone = useCallback((type: 'drum' | 'applause' | 'boo') => {
    try {
      const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext);
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      if (type === 'drum') {
        for (let i = 0; i < 10; i++) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(130 - i * 5, now + i * 0.08);
          gain.gain.setValueAtTime(0.12, now + i * 0.08);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.08 + 0.06);
          osc.connect(gain).connect(ctx.destination);
          osc.start(now + i * 0.08);
          osc.stop(now + i * 0.08 + 0.07);
        }
      }

      if (type === 'applause') {
        for (let i = 0; i < 24; i++) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(600 + Math.random() * 700, now + i * 0.035);
          gain.gain.setValueAtTime(0.035, now + i * 0.035);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.035 + 0.05);
          osc.connect(gain).connect(ctx.destination);
          osc.start(now + i * 0.035);
          osc.stop(now + i * 0.035 + 0.06);
        }
      }

      if (type === 'boo') {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(170, now);
        osc.frequency.exponentialRampToValueAtTime(95, now + 0.9);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.1);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 1.15);
      }

      setTimeout(() => ctx.close().catch(() => {}), 1600);
    } catch {}
  }, []);

  const startMicScoring = useCallback(async () => {
    micStatsRef.current = { frames: 0, voiceFrames: 0, max: 0, sum: 0, startedAt: Date.now() };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext);
      const ctx = new AudioCtx();
      micAudioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      micAnalyserRef.current = analyser;
      const data = new Uint8Array(analyser.fftSize);

      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let sumSquares = 0;
        for (let i = 0; i < data.length; i++) {
          const v = (data[i] - 128) / 128;
          sumSquares += v * v;
        }
        const rms = Math.sqrt(sumSquares / data.length);
        const stats = micStatsRef.current;
        stats.frames += 1;
        stats.sum += rms;
        stats.max = Math.max(stats.max, rms);
        if (rms > 0.018) stats.voiceFrames += 1;
        micRafRef.current = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) {
      logDebug("Microfone não liberado para karaokê. Pontuação ficará baixa: " + (e as any)?.message);
    }
  }, [logDebug]);

  const stopMicScoringAndGetScore = useCallback(() => {
    try {
      if (micRafRef.current) cancelAnimationFrame(micRafRef.current);
      micRafRef.current = null;
      micStreamRef.current?.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
      micAudioContextRef.current?.close().catch(() => {});
      micAudioContextRef.current = null;
    } catch {}

    const stats = micStatsRef.current;
    const avg = stats.frames ? stats.sum / stats.frames : 0;
    const presence = stats.frames ? stats.voiceFrames / stats.frames : 0;

    // Sem voz detectada = nota 01.
    if (stats.frames < 10 || stats.max < 0.018 || presence < 0.04) return 1;

    // Com voz: pontuação mínima 20. Considera presença + volume médio + pico.
    const presenceScore = Math.min(45, Math.round(presence * 55));
    const avgScore = Math.min(25, Math.round(avg * 450));
    const maxScore = Math.min(20, Math.round(stats.max * 240));
    const randomBonus = Math.floor(Math.random() * 10);
    return Math.max(20, Math.min(99, 20 + presenceScore + avgScore + maxScore + randomBonus));
  }, []);

  const cleanupKaraokeTimers = useCallback(() => {
    if (karaokeRollIntervalRef.current) {
      window.clearInterval(karaokeRollIntervalRef.current);
      karaokeRollIntervalRef.current = null;
    }
    if (karaokeResultTimerRef.current) {
      window.clearTimeout(karaokeResultTimerRef.current);
      karaokeResultTimerRef.current = null;
    }
    if (karaokeReturnTimerRef.current) {
      window.clearTimeout(karaokeReturnTimerRef.current);
      karaokeReturnTimerRef.current = null;
    }
  }, []);

  const returnFromKaraokeToGenres = useCallback(() => {
    cleanupKaraokeTimers();
    stopScoringSound();
    karaokeFinishLockRef.current = false;
    activeKaraokeSongRef.current = null;
    setKaraokeModeActive(false);
    karaokeModeActiveRef.current = false;
    setCurrentPlaying(null);
    setPreviewSong(null);
    setScreen('genres');
  }, [cleanupKaraokeTimers, stopScoringSound]);

  const qualifiesForKaraokeRank = useCallback((score: number) => {
    const rank = [...karaokeRank].sort((a, b) => b.score - a.score).slice(0, 10);
    if (rank.length < 10) return score > 0;
    return score > (rank[rank.length - 1]?.score || 0);
  }, [karaokeRank]);

  const finishKaraokeSong = useCallback(() => {
    if (karaokeFinishLockRef.current) return;
    karaokeFinishLockRef.current = true;
    cleanupKaraokeTimers();

    try {
      const player = ytPlayerRef.current;
      if (player && typeof player.stopVideo === 'function') player.stopVideo();
    } catch {}
    try {
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.currentTime = 0;
      }
    } catch {}

    const score = stopMicScoringAndGetScore();
    setKaraokeScore(score);
    setKaraokeDisplayScore(1);
    setKaraokeName("");
    setKaraokeKeyboardIndex(0);
    setKaraokePhase('rolling');
    setCurrentPlaying(null);
    setPreviewSong(null);
    setScreen('karaoke_score');

    // Som de suspense/pontuação enquanto os números ficam rodando.
    stopScoringSound();
    scoringAudioRef.current = playAudioAsset('/sounds/pontuacao-karaoke.mp3', { loop: true, volume: 0.9 });

    let current = 1;
    karaokeRollIntervalRef.current = window.setInterval(() => {
      current = current >= 99 ? 1 : current + Math.max(1, Math.floor(Math.random() * 9));
      if (current > 99) current = ((current - 1) % 99) + 1;
      setKaraokeDisplayScore(current);
    }, 55);

    // Segura a atenção do cliente: números rodam por 10 segundos.
    karaokeResultTimerRef.current = window.setTimeout(() => {
      if (karaokeRollIntervalRef.current) {
        window.clearInterval(karaokeRollIntervalRef.current);
        karaokeRollIntervalRef.current = null;
      }
      stopScoringSound();
      setKaraokeDisplayScore(score);
      setKaraokePhase('result');
      if (score >= 20) {
        playAudioAsset('/sounds/paumas.mp3', { volume: 1 });
      } else {
        playSimpleTone('boo');
      }

      // Mostra a pontuação final por 15 segundos antes do rank.
      karaokeResultTimerRef.current = window.setTimeout(() => {
        if (qualifiesForKaraokeRank(score)) {
          setKaraokePhase('name');
        } else {
          setKaraokePhase('saved');
          karaokeReturnTimerRef.current = window.setTimeout(() => {
            returnFromKaraokeToGenres();
          }, 15000);
        }
      }, 15000);
    }, 10000);
  }, [cleanupKaraokeTimers, playAudioAsset, playSimpleTone, qualifiesForKaraokeRank, returnFromKaraokeToGenres, stopMicScoringAndGetScore, stopScoringSound]);

  const saveKaraokeRank = useCallback(async () => {
    const name = (karaokeName.trim() || "CANTOR").substring(0, 12).toUpperCase();
    const entry = {
      name,
      score: karaokeScore,
      song: activeKaraokeSongRef.current?.title || currentPlayingRef.current?.title || "Karaokê",
      date: new Date().toISOString()
    };
    const nextRank = [...karaokeRank, entry]
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);
    setKaraokeRank(nextRank);
    localStorage.setItem("MajuBox_KaraokeRank", JSON.stringify(nextRank));
    setKaraokePhase('saved');

    // Depois que salvou o nome, mostra o Top 10 por 15 segundos e só então volta ao catálogo.
    if (karaokeReturnTimerRef.current) window.clearTimeout(karaokeReturnTimerRef.current);
    karaokeReturnTimerRef.current = window.setTimeout(() => {
      returnFromKaraokeToGenres();
    }, 15000);

    try {
      await api.post(getFullUrl('/machine/karaoke/score'), {
        hwid,
        token,
        name,
        score: karaokeScore,
        song_title: entry.song
      });
    } catch {}
  }, [api, getFullUrl, hwid, karaokeName, karaokeRank, karaokeScore, returnFromKaraokeToGenres, token]);

  const handleKaraokeKey = useCallback((key: string) => {
    if (key === 'OK') {
      saveKaraokeRank();
      return;
    }
    if (key === 'DEL') {
      setKaraokeName(prev => prev.slice(0, -1));
      return;
    }
    setKaraokeName(prev => (prev + key).slice(0, 12));
  }, [saveKaraokeRank]);

  useEffect(() => {
    screenRef.current = screen;
  }, [screen]);

  useEffect(() => {
    karaokeModeActiveRef.current = karaokeModeActive;
  }, [karaokeModeActive]);

  useEffect(() => {
    if (screen !== 'playing' || !karaokeModeActive || !currentPlaying) return;

    const timer = window.setInterval(() => {
      try {
        const player = ytPlayerRef.current;
        if (!player || typeof player.getPlayerState !== 'function') return;

        const state = player.getPlayerState();
        const current = typeof player.getCurrentTime === 'function' ? player.getCurrentTime() : 0;
        const duration = typeof player.getDuration === 'function' ? player.getDuration() : 0;

        if (state === 0 || (duration > 15 && current > 5 && duration - current <= 1.5)) {
          finishKaraokeSong();
        }
      } catch {}
    }, 700);

    return () => window.clearInterval(timer);
  }, [screen, karaokeModeActive, currentPlaying, finishKaraokeSong]);

  // --- Initial Loading ---
  useEffect(() => {
    const initApp = async () => {
      const config = await loadConfig();
      if (config) {
        if (config.serverUrl) {
          setServerUrl(config.serverUrl);
          setServerUrlInput(config.serverUrl);
        }
        if (config.token) {
          setToken(config.token);
          setTokenInput(config.token);
        }
        if (config.mpToken) {
          setMpToken(config.mpToken);
          setMpTokenInput(config.mpToken);
        }
        if (config.credits !== undefined) setCredits(config.credits);
        if (config.pixRevenue !== undefined) setTotalRevenue(config.pixRevenue);
        else if (config.revenue !== undefined) setTotalRevenue(config.revenue);
        if (config.cashRevenue !== undefined) setCashRevenue(config.cashRevenue);
        logDebug("Configurações carregadas da memória.");
      }
      setIsConfigLoaded(true);
    };
    initApp();
  }, [logDebug]);

  // Auto-save when values change
  useEffect(() => {
    if (isConfigLoaded) {
      saveConfig({ serverUrl, token, mpToken, credits, revenue: totalRevenue, pixRevenue: totalRevenue, cashRevenue });
    }
  }, [serverUrl, token, mpToken, credits, totalRevenue, cashRevenue, isConfigLoaded]);

  // Teclas de atalho para Smart TV / Controles
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Tecla "6" para inserir crédito manual
      if (e.key === '6') {
        addManualCredits(1);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [addManualCredits]);

  // Idle / Attract Mode logic
  const [lastInteraction, setLastInteraction] = useState(Date.now());
  const [isAttractMode, setIsAttractMode] = useState(false);
  const isAttractModeRef = useRef(isAttractMode);
  const [attractQueue, setAttractQueue] = useState<Song[]>([]);

  useEffect(() => {
    isAttractModeRef.current = isAttractMode;
  }, [isAttractMode]);
  const [attractIndex, setAttractIndex] = useState(0);

  const [ytPlayerState, setYtPlayerState] = useState(-1);
  const ytPlayerRef = useRef<any>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const genresListRef = useRef<HTMLDivElement>(null);
  const dvdsListRef = useRef<HTMLDivElement>(null);
  const songsListRef = useRef<HTMLDivElement>(null);
  
  useDraggableScroll(genresListRef);
  useDraggableScroll(dvdsListRef);
  useDraggableScroll(songsListRef);

  const pendingVideoRef = useRef<string | null>(null);
  const queueRef = useRef<Song[]>(queue);

  // Sync queueRef
  useEffect(() => {
    queueRef.current = queue;
  }, [queue]);

  const resetIdle = useCallback(() => {
    setLastInteraction(Date.now());
    if (isAttractMode) {
      setIsAttractMode(false);
      setCurrentPlaying(null);
      setScreen('genres');
    }
  }, [isAttractMode]);

  // Global Interaction Listener
  useEffect(() => {
    const handleInteraction = () => resetIdle();
    window.addEventListener('mousedown', handleInteraction, { passive: true });
    window.addEventListener('touchstart', handleInteraction, { passive: true });
    return () => {
      window.removeEventListener('mousedown', handleInteraction);
      window.removeEventListener('touchstart', handleInteraction);
    };
  }, [isAttractMode, resetIdle]);

  // Sincronização secundária para buscar gêneros se não vierem no check
  const fetchGenres = useCallback(async () => {
    try {
      logDebug("Buscando gêneros (GET /machine/genres)...");
      const res = await api.get('/machine/genres');
      const data = res.data;
      
      // Tenta extrair lista de gêneros de vários campos possíveis
      const rawList = data.genres || data.categories || data.generos || data.categories_list || (Array.isArray(data) ? data : []);
      const rawGenres = Array.isArray(rawList) ? rawList : Object.values(rawList);

      if (rawGenres.length > 0) {
        const normalizedGenres = rawGenres.map((g: any) => {
          const rawItems = g.playlists || g.musicas || g.items || g.dvds || g.songs || g.conteudo || [];
          const items = Array.isArray(rawItems) ? rawItems : Object.values(rawItems);
          return { 
            ...g, 
            name: g.name || g.nome || g.title || g.titulo || "Gênero",
            playlists: items 
          };
        });
        setGenres(normalizedGenres);
        const totalItems = normalizedGenres.reduce((acc: number, g: any) => acc + (g.playlists?.length || 0), 0);
        logDebug(`Gêneros carregados via /machine/genres: ${normalizedGenres.length} gêneros, ${totalItems} itens.`);
        return true;
      }
      return false;
    } catch (e: any) {
      logDebug(`Erro ao buscar gêneros (GET): ${e.message}`);
      // Tenta via POST como fallback
      try {
        logDebug("Tentando POST /machine/genres como fallback...");
        const resPost = await api.post('/machine/genres', { hwid, token });
        if (resPost.data && Array.isArray(resPost.data)) {
           // ... process similar to above ...
           const rawList = resPost.data.genres || resPost.data.categories || resPost.data.generos || (Array.isArray(resPost.data) ? resPost.data : []);
           const rawGenres = Array.isArray(rawList) ? rawList : Object.values(rawList);
           if (rawGenres.length > 0) {
             const normalizedGenres = rawGenres.map((g: any) => {
               const rawItems = g.playlists || g.musicas || g.items || g.dvds || g.songs || g.conteudo || [];
               const items = Array.isArray(rawItems) ? rawItems : Object.values(rawItems);
               return { ...g, name: g.name || g.nome || "Gênero", playlists: items };
             });
             setGenres(normalizedGenres);
             return true;
           }
           return true; 
        }
      } catch (e2) {}
      return false;
    }
  }, [api, logDebug, hwid, token]);

  // Sincronização inicial
  const syncWithServer = useCallback(async () => {
    if (!hwid) return;
    
    setIsLoading(true);
    setSyncError("");
    logDebug(`Iniciando Sincronização (HWID: ${hwid}, Server: ${serverUrl})`);

    const machineName = localStorage.getItem("MajuBox_MachineName") || `MajuBox-${hwid.substring(0, 6)}`;
    const adminPass = localStorage.getItem("MajuBox_AdminPass") || "1234";
    const pendingLibPayment = localStorage.getItem("MajuBox_PendingLibPayment");

    // Tentar Handshake via /machine/check ou /proxy/check
    const tryCheck = async (endpoint: string) => {
      logDebug(`Attempting Sync: ${endpoint}`);
      const payload: any = {
        hwid,
        machine_name: machineName,
        admin_pass: adminPass,
        license_verify: pendingLibPayment || ""
      };
      
      // Só envia o token se ele existir e for válido
      if (token && token.trim() !== "") {
        payload.token = token;
      }

      return await api.post(endpoint, payload);
    };

    try {
      let response;
      try {
        response = await tryCheck("/machine/check");
      } catch (e: any) {
        logDebug(`Erro no check principal: ${e.message}. Tentando proxy/check...`);
        response = await tryCheck("/proxy/check");
      }

      const data = response.data;
      if (!data) {
        logDebug(`Resposta do servidor vazia. Status: ${response.status}`);
        throw new Error(`O servidor respondeu com sucesso (200) mas sem dados (Status: ${response.status}). Verifique o seu backend Python.`);
      }

      // Se for string, tenta parsear (acontece se o proxy retornar HTML por erro do target)
      let finalData = data;
      if (typeof data === 'string') {
        try {
          finalData = JSON.parse(data);
        } catch (e) {
          if (data.includes('<!DOCTYPE html>') || data.includes('<html')) {
            throw new Error(`O servidor em ${serverUrl} retornou uma página HTML em vez de JSON. Verifique a URL.`);
          }
          throw new Error(`O servidor retornou um formato inválido: ${data.substring(0, 50)}...`);
        }
      }

      // Sucesso no handshake ou pelo menos retorno válido
      if (finalData.ok || finalData.status === 'ok' || finalData.machine_id || finalData.genres || finalData.id) {
        logDebug(`Sync Success: Machine ID ${finalData.machine_id || finalData.id}`);
        if (finalData.token && finalData.token !== token) {
          setToken(finalData.token);
          localStorage.setItem("MajuBox_Token", finalData.token);
        }

        if (finalData.license_price) setLicensePrice(finalData.license_price);

        const pix = finalData.pix_liberation || finalData.pix || finalData.pix_data;
        setLicenseInfo({
          ok: finalData.license_ok !== false,
          exp: finalData.license_exp || "",
          pix: pix,
        });

        if (pix?.payment_id) {
          localStorage.setItem("MajuBox_PendingLibPayment", pix.payment_id);
        }

        const isLocked = finalData.license_ok === false;
        if (isLocked) {
          setScreen("locked");
          logDebug("Licença expirada.");
        } else {
          localStorage.removeItem("MajuBox_PendingLibPayment");
          
          // Se vier gêneros no check, usa eles
          const rawGenresList = finalData.genres || finalData.categories || finalData.generos || finalData.categories_list;
          if (rawGenresList) {
            const rawGenres = Array.isArray(rawGenresList) ? rawGenresList : Object.values(rawGenresList);
            const normalizedGenres = rawGenres.map((g: any) => {
              const rawItems = g.playlists || g.musicas || g.items || g.dvds || g.songs || g.conteudo || [];
              const items = Array.isArray(rawItems) ? rawItems : Object.values(rawItems);
              return { 
                ...g, 
                name: g.name || g.nome || g.title || g.titulo || "Gênero",
                playlists: items 
              };
            });
            setGenres(normalizedGenres);
            logDebug(`Sincronizado via check: ${normalizedGenres.length} gêneros.`);
          } else {
            // Se não veio gêneros, tenta buscar na rota secundária
            await fetchGenres();
          }
          
          setScreen(curr => (curr === "locked" || curr === "welcome") ? "genres" : curr);
        }
      } else {
        const errMsg = finalData.error || finalData.message || "Erro no servidor (Check failed)";
        logDebug(`Servidor recusou handshake: ${errMsg}`);
        setSyncError(errMsg);
        // Tenta buscar gêneros mesmo se check falhar (pode ser que o server precise apenas de identificação)
        await fetchGenres();
      }
    } catch (err: any) {
      const status = err.response?.status;
      const errorMsg = err.response?.data?.error || err.response?.data?.message || err.message;
      logDebug(`Falha crítica de conexão: ${errorMsg} (Status: ${status || '?'})`);
      setSyncError(`Falha na conexão: ${errorMsg}`);
      
      // Fallback radical: tenta apenas carregar gêneros
      const gotGenres = await fetchGenres();
      if (gotGenres) {
         setScreen(curr => (curr === "locked" || curr === "welcome") ? "genres" : curr);
         setSyncError(""); // Limpa o erro se conseguimos os dados
      }
    } finally {
      setIsLoading(false);
    }
  }, [serverUrl, token, hwid, logDebug, api, fetchGenres]);

  // Resetar Cursor ao mudar de tela
  useEffect(() => {
    setCursorIndex(0);
  }, [screen]);

  // Logica de polling de pagamento
  useEffect(() => {
    let interval: any;
    const checkPayment = async () => {
      const pId = pixData?.id || pixData?.payment_id || pixData?.external_reference;
      if (!pId) return;

      try {
        const url = getFullUrl('/machine/pix/status');
        const res = await api.post(url, {
          token,
          payment_id: pId
        });
        
        const data = res.data;
        // Verifica padrão específico solicitado: ok: true, status: "approved", credited: true
        if (
          (data.ok === true && data.status === 'approved') || 
          data.credited === true ||
          data.status === 'paid' || 
          data.paid === true
        ) {
          setCredits(prev => prev + (data.credits_added || pixData.credits || 2));
          playCreditSound();
          setTotalRevenue(prev => prev + (data.amount || pixData.amount || 1.00));
          setPixData(null);
          setScreen('genres');
          clearInterval(interval);
        }
      } catch (err) {
        console.error("Erro ao checar pagamento", err);
      }
    };

    if (screen === 'pix' && pixData) {
      interval = setInterval(checkPayment, 5000);
    }
    return () => clearInterval(interval);
  }, [screen, pixData, serverUrl, token, playCreditSound]);

  // Logica de Preview de 6 segundos
  useEffect(() => {
    let interval: any;
    if (previewSong && previewTimer > 0) {
      interval = setInterval(() => {
        setPreviewTimer(prev => {
          if (prev <= 1) {
            setPreviewSong(null);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [previewSong, previewTimer]);

  // Navegação por Teclado
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignorar atalhos se o usuário estiver digitando em um input
      if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') {
        if (e.key === 'Escape') (document.activeElement as HTMLElement).blur();
        return;
      }

      resetIdle();

      if (screen === 'karaoke_score' && karaokePhase !== 'name') {
        // Durante a pontuação/final/rank, não deixa ENTER, G, ESC ou outros comandos
        // tirarem a tela antes do tempo programado.
        e.preventDefault();
        return;
      }

      if (screen === 'karaoke_score' && karaokePhase === 'name') {
        const cols = 7;
        const total = KARAOKE_KEYS.length + 2;
        if (e.key === 'ArrowRight') {
          setKaraokeKeyboardIndex(prev => (prev + 1) % total);
          e.preventDefault();
          return;
        }
        if (e.key === 'ArrowLeft') {
          setKaraokeKeyboardIndex(prev => (prev - 1 + total) % total);
          e.preventDefault();
          return;
        }
        if (e.key === 'ArrowDown') {
          setKaraokeKeyboardIndex(prev => Math.min(total - 1, prev + cols));
          e.preventDefault();
          return;
        }
        if (e.key === 'ArrowUp') {
          setKaraokeKeyboardIndex(prev => Math.max(0, prev - cols));
          e.preventDefault();
          return;
        }
        if (e.key === 'Enter') {
          const key = karaokeKeyboardIndex < KARAOKE_KEYS.length ? KARAOKE_KEYS[karaokeKeyboardIndex] : (karaokeKeyboardIndex === KARAOKE_KEYS.length ? 'DEL' : 'OK');
          handleKaraokeKey(key);
          e.preventDefault();
          return;
        }
        if (e.key === 'Backspace') {
          setKaraokeName(prev => prev.slice(0, -1));
          e.preventDefault();
          return;
        }
        e.preventDefault();
        return;
      }

      // Teclas de atalho globais
      if (e.key === '4') {
        setScreen('admin');
        return;
      }
      if (e.key === '5') {
        setScreen('reading');
        return;
      }
      if (e.key === 'j' || e.key === 'J') {
        setScreen('pix');
        return;
      }
      if (e.key === 'g' || e.key === 'G') {
        setScreen('genres');
        return;
      }
      if (e.key === 'p' || e.key === 'P') {
        const amountCredits = 2;
        const amountMoney = amountCredits / 2;
        addManualCredits(amountCredits);
        // Notificar server separando dinheiro/manual do PIX
        api.post('/api/machine/add_credits', { hwid, token, credits: amountCredits, amount: amountMoney, type: 'manual' }).catch(() => {});
        return;
      }

      // Se houver preview na tela, Enter confirma a música
      if (previewSong) {
        if (e.key === 'Enter') {
          confirmSelection();
        } else if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'ArrowLeft') {
          setPreviewSong(null);
        }
        return;
      }

      // Navegação por lista
      if (['genres', 'dvds', 'songs'].includes(screen)) {
        let max = 0;
        let columns = 1;
        if (screen === 'genres') {
          max = genres.length;
          columns = window.innerWidth >= 768 ? 3 : 2;
        }
        if (screen === 'dvds') {
          const playlists = selectedGenre?.playlists || [];
          const dvdsMap: Record<string, any> = {};
          playlists.forEach((p, idx) => { 
            const dId = (p as any).dvd_id || `legacy-${idx}`;
            dvdsMap[dId] = true; 
          });
          max = Object.keys(dvdsMap).length;
          if (window.innerWidth >= 1024) columns = 4;
          else if (window.innerWidth >= 768) columns = 3;
          else columns = 2;
        }
        if (screen === 'songs') {
          max = selectedDVD?.songs.length || 0;
          columns = 1;
        }

        if (e.key === 'ArrowDown') {
          setCursorIndex(prev => (prev + columns < max ? prev + columns : prev % columns));
          e.preventDefault();
        } else if (e.key === 'ArrowUp') {
          setCursorIndex(prev => (prev - columns >= 0 ? prev - columns : (prev + (Math.ceil(max/columns)-1)*columns) % max));
          e.preventDefault();
        } else if (e.key === 'ArrowRight' && columns > 1) {
          setCursorIndex(prev => (prev + 1 < max ? prev + 1 : 0));
          e.preventDefault();
        } else if (e.key === 'ArrowLeft') {
          if (screen === 'songs') {
            setScreen('dvds');
            e.preventDefault();
          } else if (screen === 'dvds') {
            setScreen('genres');
            e.preventDefault();
          } else if (columns > 1) {
            setCursorIndex(prev => (prev - 1 >= 0 ? prev - 1 : max - 1));
            e.preventDefault();
          }
        } else if (e.key === 'Enter') {
          const elements = document.querySelectorAll('.selectable-item');
          if (elements[cursorIndex]) {
            (elements[cursorIndex] as HTMLElement).click();
          }
        } else if (e.key === 'Escape' || e.key === 'Backspace') {
          if (screen === 'songs') setScreen('dvds');
          else if (screen === 'dvds') setScreen('genres');
          else if (screen === 'genres') setScreen('welcome');
        }
      } else if (screen === 'playing') {
        if (e.key === 'ArrowLeft') {
          setScreen('songs');
          e.preventDefault();
        } else if (e.key === 'Escape' || e.key === 'Backspace') {
          setKaraokeModeActive(false);
          setCurrentPlaying(null);
          setScreen('genres');
        }
      } else if (screen === 'admin' || screen === 'reading' || screen === 'pix' || screen === 'queue') {
        if (e.key === 'Escape' || e.key === 'Backspace') {
          setScreen('genres');
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [screen, genres, selectedGenre, selectedDVD, cursorIndex, previewSong, credits, karaokePhase, karaokeKeyboardIndex, karaokeName, handleKaraokeKey, addManualCredits]);

  // Scroll automático
  useEffect(() => {
    const activeEl = document.querySelector('.cursor-active');
    if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [cursorIndex]);

  // Reset cursor index when changing screen
  useEffect(() => {
    setCursorIndex(0);
    setPreviewSong(null);
  }, [screen]);

  useEffect(() => {
    if (isConfigLoaded) {
      syncWithServer();
    }
  }, [token, syncWithServer, isConfigLoaded]);

  // Carregar gêneros ao entrar no Admin
  useEffect(() => {
    if (screen === 'admin') {
      const fetchAdminGenres = async () => {
        try {
          const res = await api.get(getFullUrl('/machine/genres'));
          const data = res.data?.genres || res.data;
          if (Array.isArray(data)) {
            setGenres(data);
          }
        } catch (e) {
          // Fallback to sync if GET fails
          if (token) syncWithServer();
        }
      };
      fetchAdminGenres();
    }
  }, [screen, api, token, syncWithServer, getFullUrl]);

  const handleLogoClick = () => {
    logDebug("Logo tapped");
    setTapCount(prev => {
      const next = prev + 1;
      if (next >= 5) {
        setShowDebug(true);
        setScreen('admin');
        return 0;
      }
      return next;
    });
  };

  // Auto-gerar PIX ao entrar na tela
  useEffect(() => {
    if (screen === 'pix' && !pixData && !isLoading) {
      generatePix();
    }
  }, [screen]);

  const generatePix = async () => {
    if (!mpToken) {
      setSyncError("Mercado Pago não configurado. Vá em Admin.");
      return;
    }
    setIsLoading(true);
    try {
      const url = getFullUrl('/machine/pix/create');
      const response = await api.post(url, { 
        mp_token: mpToken, 
        amount: 1.00, 
        credits: 2 
      });
      const data = response.data;
      if (data.ok) {
        setPixData(data);
      } else {
        setSyncError(data.error || "Erro ao gerar PIX");
      }
    } catch (err) {
      console.error("Falha ao gerar PIX:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const startPreview = (song: Song) => {
    resetIdle();
    if (credits <= 0) {
      setScreen('pix');
      return;
    }
    setPreviewSong(song);
    setPreviewTimer(6);
  };

  // Force Play YouTube logic to leverage user gesture
  const forcePlayYoutube = useCallback((youtubeId: string) => {
    pendingVideoRef.current = youtubeId;
    const p = ytPlayerRef.current;

    if (p && typeof p.loadVideoById === 'function') {
      try {
        p.loadVideoById(youtubeId);
        p.unMute();
        p.setVolume(100);
        p.playVideo();

        let tries = 0;
        const retry = setInterval(() => {
          tries++;
          try {
            const state = p.getPlayerState();
            setYtPlayerState(state);
            if (state !== 1) { // 1 = PLAYING
              p.unMute();
              p.setVolume(100);
              p.playVideo();
            } else {
              clearInterval(retry);
            }
          } catch (e) {}

          if (tries > 20) clearInterval(retry);
        }, 300);
      } catch (err) {
        console.error("Error in forcePlayYoutube:", err);
      }
    }
  }, []);

  // YouTube Singleton Player Initialization
  useEffect(() => {
    const createPlayer = () => {
      const win = window as any;

      if (!win.YT || !win.YT.Player) {
        setTimeout(createPlayer, 300);
        return;
      }

      if (ytPlayerRef.current) return;

      try {
        ytPlayerRef.current = new win.YT.Player('yt-player', {
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            controls: 0,
            mute: 0,
            enablejsapi: 1,
            playsinline: 1,
            modestbranding: 1,
            rel: 0,
            iv_load_policy: 3,
            fs: 1,
            origin: window.location.origin
          },
          events: {
            onReady: (event: any) => {
              ytPlayerRef.current = event.target;
              if (pendingVideoRef.current) {
                event.target.loadVideoById(pendingVideoRef.current);
                event.target.unMute();
                event.target.setVolume(100);
                event.target.playVideo();
              }
            },
            onStateChange: (event: any) => {
              const state = event.data;
              setYtPlayerState(state);
              
              if (state === (window as any).YT.PlayerState.PLAYING) {
                event.target.unMute();
                event.target.setVolume(100);
              }

              if (state === (window as any).YT.PlayerState.PAUSED) {
                // Forçar o play se pausou indevidamente
                if (currentPlayingRef.current) {
                  setTimeout(() => {
                    if (ytPlayerRef.current) ytPlayerRef.current.playVideo();
                  }, 1000);
                }
              }

              if (state === 0 || state === (window as any).YT?.PlayerState?.ENDED) {
                if (karaokeFinishLockRef.current || screenRef.current === 'karaoke_score') {
                  return;
                }
                if (karaokeModeActiveRef.current) {
                  finishKaraokeSong();
                  return;
                }
                const currentQueue = queueRef.current;
                if (currentQueue.length > 0) {
                  const next = currentQueue[0];
                  setQueue(prev => prev.slice(1));
                  setCurrentPlaying(next);
                  if (next.youtube_id) {
                    forcePlayYoutube(next.youtube_id);
                  }
                } else if (!isAttractModeRef.current) {
                  setCurrentPlaying(null);
                  setScreen('genres');
                }
              }
            },
            onError: (e: any) => {
              logDebug("YT Player Error: " + e.data);
              const currentQueue = queueRef.current;
              if (currentQueue.length > 0) {
                const next = currentQueue[0];
                setQueue(prev => prev.slice(1));
                setCurrentPlaying(next);
                if (next.youtube_id) forcePlayYoutube(next.youtube_id);
              }
            }
          }
        });
      } catch (err) {
        console.error("Error creating YT player:", err);
      }
    };

    if (!(window as any).YT) {
      const tag = document.createElement('script');
      tag.id = 'youtube-api';
      tag.src = 'https://www.youtube.com/iframe_api';
      const firstScriptTag = document.getElementsByTagName('script')[0];
      firstScriptTag.parentNode?.insertBefore(tag, firstScriptTag);
    }

    createPlayer();
  }, [forcePlayYoutube]); // Note: isAttractMode is used inside but depends on ref/state mostly


  // Logica de Attract Mode (20 min idle)
  useEffect(() => {
    const checkIdle = setInterval(() => {
      if (screen !== 'genres' && screen !== 'welcome' && screen !== 'dvds' && screen !== 'songs') return;
      if (isAttractMode) return;

      const idleTime = Date.now() - lastInteraction;
      const twentyMinutes = 20 * 60 * 1000;
      
      if (idleTime > twentyMinutes) {
        // Iniciar modo de demonstração
        const allSongs: Song[] = [];
        genres.forEach(g => {
          g.playlists.forEach(p => {
             // Tenta extrair músicas conforme a lógica normalizada nos DVDs
             const songs = p.songs || (p as any).musicas || [];
             allSongs.push(...songs);
          });
        });

        if (allSongs.length > 0) {
          // Embaralhar e pegar 20
          const shuffled = [...allSongs].sort(() => 0.5 - Math.random());
          const selection = shuffled.slice(0, 20);
          setAttractQueue(selection);
          setAttractIndex(0);
          setIsAttractMode(true);
          setCurrentPlaying(selection[0]);
          setScreen('playing');
        }
      }
    }, 30000); // Checa a cada 30 segundos

    return () => clearInterval(checkIdle);
  }, [lastInteraction, screen, genres, isAttractMode]);

  // Logica de Retorno ao Vídeo (5 segundos sem interação se música tocando)
  useEffect(() => {
    if (['playing', 'welcome', 'locked', 'pix', 'admin', 'reading', 'queue', 'karaoke_score'].includes(screen) || !currentPlaying || isAttractMode) return;

    const returnTimer = setTimeout(() => {
      setScreen('playing');
    }, 5000);

    return () => clearTimeout(returnTimer);
  }, [screen, lastInteraction, currentPlaying, isAttractMode]);

  // Logica de Troca no Attract Mode (15 segundos por música)
  useEffect(() => {
    let timer: any;
    if (isAttractMode && screen === 'playing' && currentPlaying) {
      timer = setTimeout(() => {
        const nextIdx = attractIndex + 1;
        if (nextIdx < attractQueue.length) {
          setAttractIndex(nextIdx);
          setCurrentPlaying(attractQueue[nextIdx]);
        } else {
          // Fim da demonstração
          setIsAttractMode(false);
          setKaraokeModeActive(false);
          setCurrentPlaying(null);
          setScreen('genres');
        }
      }, 15000);
    }
    return () => clearTimeout(timer);
  }, [isAttractMode, attractIndex, attractQueue, screen, currentPlaying]);

  // Hide cursor after 3s of inactivity on TV/Web
  useEffect(() => {
    let timeout: any;
    const handleActivity = () => {
      document.body.style.cursor = 'default';
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        if (screen !== 'admin' && screen !== 'config') {
          document.body.style.cursor = 'none';
        }
      }, 3000);
    };

    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('mousedown', handleActivity);
    window.addEventListener('touchstart', handleActivity);
    window.addEventListener('keydown', handleActivity);

    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('mousedown', handleActivity);
      window.removeEventListener('touchstart', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      clearTimeout(timeout);
    };
  }, [screen]);

  const confirmSelection = async () => {
    if (!previewSong || credits <= 0) return;
    
    const song = previewSong;
    setCredits(prev => prev - 1);
    setPreviewSong(null);
    
    if (!currentPlaying) {
      const shouldScoreKaraoke = isKaraokeContext(song);
      setKaraokeModeActive(shouldScoreKaraoke);
      karaokeModeActiveRef.current = shouldScoreKaraoke;
      karaokeFinishLockRef.current = false;
      activeKaraokeSongRef.current = shouldScoreKaraoke ? song : null;
      if (shouldScoreKaraoke) {
        startMicScoring();
      }
      setCurrentPlaying(song);
      setScreen('playing');
      if (song.youtube_id) {
        forcePlayYoutube(song.youtube_id);
      }
    } else {
      setQueue(prev => [...prev, song]);
      // Garantir que a reprodução continue se estiver pausada
      if (ytPlayerRef.current) {
        try {
          const state = ytPlayerRef.current.getPlayerState();
          if (state === 2) ytPlayerRef.current.playVideo();
        } catch (e) {}
      }
      if (videoRef.current && videoRef.current.paused) {
        videoRef.current.play().catch(() => {});
      }
    }

    // Log play to server
    try {
      await api.post('/machine/play', { 
        hwid, 
        token,
        playlist_id: song.id,
        song_id: song.id,
        credits_left: credits - 1
      });
    } catch (e) {
      logDebug(`Erro ao notificar play ao servidor: ${e.message}`);
    }
  };

  const playNow = (song: Song) => {
    startPreview(song);
  };

  const addToQueue = (song: Song) => {
    startPreview(song);
  };

  const resetCredits = () => {
    if (confirm("Deseja zerar os créditos atuais?")) {
      setCredits(0);
    }
  };

  const resetRevenue = () => {
    if (confirm("Deseja zerar o contador de arrecadação? Isso zera o dinheiro/manual e o PIX, mas não zera créditos atuais.")) {
      setTotalRevenue(0);
      setCashRevenue(0);
    }
  };

  const saveSettings = async () => {
    const machineName = localStorage.getItem("MajuBox_MachineName") || `MajuBox-${hwid.substring(0, 4)}`;
    const adminPass = localStorage.getItem("MajuBox_AdminPass") || "1234";

    // Update main states
    setServerUrl(serverUrlInput);
    setToken(tokenInput);
    setMpToken(mpTokenInput);
    
    saveConfig({ serverUrl: serverUrlInput, token: tokenInput, mpToken: mpTokenInput, credits, revenue: totalRevenue, pixRevenue: totalRevenue, cashRevenue });
    
    // Save info to server (Handshake/Sync)
    try {
      await api.post(getFullUrl('/machine/check'), { 
        token: tokenInput,
        hwid,
        // Enviar todas as variações possíveis para garantir compatibilidade com o servidor remoto
        name: machineName,
        machine_name: machineName,
        admin_pass: adminPass,
        admin_password: adminPass,
        password: adminPass,
        mp_token: mpTokenInput,
        serverUrl: serverUrlInput 
      });
    } catch (e) {}

    // Force sync with new values
    setTimeout(() => syncWithServer(), 100);
    setScreen('genres');
  };


  const handleGenreSelect = useCallback((genre: Genre) => {
    if (flippingGenreId !== null) return;

    setFlippingGenreId(genre.id);
    setSelectedGenre(genre);

    window.setTimeout(() => {
      setScreen('dvds');
      setCursorIndex(0);
      setFlippingGenreId(null);
    }, 620);
  }, [flippingGenreId]);

  if (!isConfigLoaded) {
    return (
      <div className="h-screen w-full bg-brand-dark flex flex-col items-center justify-center">
        <RefreshCw className="w-12 h-12 animate-spin text-brand-red mb-4" />
        <p className="text-zinc-500 font-bold uppercase tracking-widest text-xs">Carregando Configurações...</p>
      </div>
    );
  }

  return (
    <div className="h-screen w-full bg-brand-dark flex flex-col font-sans select-none overflow-hidden">
      <AnimatePresence mode="wait">
        
        {/* --- DEBUG CONSOLE --- */}
        {showDebug && (
          <div className="fixed inset-x-0 top-0 z-[100] bg-black/90 p-4 font-mono text-[10px] text-green-400 max-h-48 overflow-y-auto">
            <div className="flex justify-between items-center mb-2 border-b border-green-900 pb-1">
              <span>DEBUG WINDOW</span>
              <button onClick={() => setShowDebug(false)} className="text-white bg-red-900 px-2 rounded">X</button>
            </div>
            {debugLogs.map((log, i) => <div key={i}>{log}</div>)}
          </div>
        )}
        {previewSong && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/90 backdrop-blur-sm"
          >
            <div className="w-full max-w-lg bg-zinc-900 rounded-[2.5rem] border border-zinc-800 overflow-hidden shadow-2xl flex flex-col">
              <div className="aspect-video bg-black relative flex items-center justify-center">
                 {previewSong.youtube_id ? (
                   <iframe 
                     className="w-full h-full"
                     src={`https://www.youtube.com/embed/${previewSong.youtube_id}?autoplay=1&controls=1&mute=0&start=10&playsinline=1&enablejsapi=1&origin=${encodeURIComponent(window.location.origin)}`}
                     frameBorder="0"
                     allow="autoplay; encrypted-media"
                   ></iframe>
                 ) : (
                   <Play className="w-16 h-16 text-brand-red animate-pulse" />
                 )}
                 <div className="absolute top-4 right-4 bg-brand-red text-white w-10 h-10 rounded-full flex items-center justify-center font-black">
                   {previewTimer}
                 </div>
              </div>
              
              <div className="p-8 text-center bg-zinc-900">
                <h2 className="text-2xl font-black mb-1">{previewSong.title}</h2>
                <p className="text-brand-red font-bold uppercase tracking-widest text-xs mb-8">{previewSong.artist}</p>
                
                <div className="flex gap-4">
                  <button 
                    onClick={confirmSelection}
                    className="flex-1 bg-brand-red py-4 rounded-2xl font-black text-sm tracking-widest shadow-xl shadow-brand-red/20 active:scale-95 transition-all text-white"
                  >
                    CONFIRMAR (ENTER)
                  </button>
                  <button 
                    onClick={() => setPreviewSong(null)}
                    className="flex-1 bg-zinc-800 py-4 rounded-2xl font-black text-sm tracking-widest active:bg-zinc-700 text-white"
                  >
                    CANCELAR (ESC)
                  </button>
                </div>
                <p className="mt-4 text-[10px] text-zinc-600 font-bold uppercase">Custo: 1 Crédito</p>
              </div>
            </div>
          </motion.div>
        )}
        
        {/* --- LOCKED SCREEN --- */}
        {screen === 'locked' && (
          <motion.div 
            key="locked"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-zinc-950"
          >
            <div className="bg-red-500/10 p-6 rounded-full mb-6">
              <AlertTriangle className="w-16 h-16 text-red-500" />
            </div>
            <h1 className="text-3xl font-black mb-2 italic">LICENÇA EXPIRADA</h1>
            <p className="text-zinc-500 text-sm mb-10 max-w-xs leading-relaxed">Sua licença de uso venceu. Efetue o pagamento para liberar mais 30 dias de uso.</p>
            
            {licenseInfo?.pix ? (
              <div className="bg-white p-4 rounded-3xl mb-8 shadow-2xl">
                 <QRCodeSVG value={licenseInfo.pix.copy_paste || "pagamento"} size={180} />
                 <p className="text-[10px] text-zinc-400 font-bold mt-2 uppercase tracking-tighter">Valor: R$ {licenseInfo.pix.amount?.toFixed(2)}</p>
              </div>
            ) : (
              <div className="bg-zinc-900 p-8 rounded-3xl mb-10 text-zinc-500 font-bold uppercase tracking-widest text-xs border border-zinc-800">
                Aguardando servidor...
              </div>
            )}

            <div className="flex flex-col gap-4 w-full max-w-xs">
              <button 
                onClick={syncWithServer}
                className="w-full bg-brand-red py-4 rounded-2xl font-black text-xs tracking-widest active:scale-95 transition-all text-white"
              >
                JÁ PAGUEI, VERIFICAR
              </button>
              <button 
                onClick={() => setScreen('admin')}
                className="text-zinc-600 font-bold text-[10px] uppercase tracking-widest"
              >
                MENU ADMINISTRADOR
              </button>
            </div>
            <p className="fixed bottom-8 text-[10px] text-zinc-800 font-mono">HWID: {hwid}</p>
          </motion.div>
        )}

        {/* --- WELCOME SCREEN --- */}
        {screen === 'welcome' && (
          <motion.div 
            key="welcome"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center p-8 text-center"
          >
            <motion.div 
              onClick={handleLogoClick}
              whileTap={{ scale: 0.95 }}
              className="w-32 h-32 bg-brand-red rounded-3xl flex items-center justify-center shadow-2xl pulsate cursor-pointer mb-8 relative"
            >
              <Music className="w-16 h-16 text-white" />
              {tapCount > 0 && (
                <div className="absolute -top-2 -right-2 bg-zinc-900 text-white text-[10px] w-6 h-6 rounded-full flex items-center justify-center border-2 border-brand-dark">
                  {tapCount}
                </div>
              )}
            </motion.div>
            <h1 className="text-5xl font-bold tracking-tight mb-2">MajuBox</h1>
            <p className="text-zinc-500 text-lg mb-12">Pode conter anúncios • Online</p>
            
            <button 
              onClick={() => setShowDebug(true)}
              className="fixed bottom-4 right-4 bg-zinc-900/50 text-zinc-600 p-2 rounded-lg text-[10px] font-bold uppercase tracking-widest border border-zinc-800"
            >
              Ver Log / Erros
            </button>

            {!token ? (
              <div className="flex flex-col items-center gap-4 w-full max-w-xs">
                <p className="text-sm text-zinc-500 mb-4 px-6">Para começar, você precisa configurar seu servidor e token.</p>
                <button 
                  onClick={() => setScreen('admin')}
                  className="w-full bg-brand-red hover:bg-rose-600 text-white font-bold py-4 rounded-2xl text-xl shadow-lg"
                >
                  CONFIGURAR ACESSO
                </button>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-4 w-full max-w-xs">
                <button 
                  disabled={isLoading}
                  onClick={() => {
                    if (!termsAccepted) { setShowTermsModal(true); return; }
                    toggleFullscreen();
                    syncWithServer();
                  }}
                  className="w-full bg-brand-red hover:bg-rose-600 text-white font-bold py-4 px-12 rounded-2xl text-xl shadow-lg disabled:opacity-50 transition-all active:scale-95"
                >
                  {isLoading ? 'CONECTANDO...' : 'ENTRAR NO MAJUBOX'}
                </button>
                
                <button 
                  onClick={() => setScreen('admin')}
                  className="flex items-center gap-2 text-zinc-500 hover:text-white transition-colors py-2"
                >
                  <Settings className="w-4 h-4" />
                  <span className="text-xs font-bold uppercase tracking-widest">Configurações</span>
                </button>
                <button 
                  onClick={() => setShowTermsModal(true)}
                  className="flex items-center gap-2 text-zinc-500 hover:text-white transition-colors py-1"
                >
                  <FileText className="w-4 h-4" />
                  <span className="text-xs font-bold uppercase tracking-widest">Termos de Uso</span>
                </button>

                {syncError && <p className="text-red-500 text-sm">{syncError}</p>}
                
                {isMobile && (
                  <p className="text-[10px] text-zinc-600 mt-4 text-center bg-zinc-900/50 p-3 rounded-xl border border-zinc-800">
                    💡 <span className="text-zinc-400">Dica:</span> Se estiver no APK, configure a URL do servidor Render e seu Token no menu de <span className="text-zinc-400 font-bold">Configurações</span>.
                  </p>
                )}
              </div>
            )}
          </motion.div>
        )}

        {/* --- GENRES SCREEN --- */}
        {screen === 'genres' && (
          <motion.div 
            key="genres"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex-1 min-h-0 flex flex-col"
          >
            <Header title="Gêneros Musicais" credits={credits} onBack={() => setScreen('welcome')} onRefresh={syncWithServer} loading={isLoading} />
            <div 
              ref={genresListRef}
              className="touch-scroll flex-1 min-h-0 overflow-y-auto no-scrollbar"
            >
              <div className="p-4 grid grid-cols-2 lg:grid-cols-3 gap-6 items-start">
              {genres.map((genre, i) => (
                <div 
                  key={genre.id}
                  onClick={() => handleGenreSelect(genre)}
                  className={`selectable-item genre-card aspect-square bg-brand-surface rounded-[2.5rem] flex flex-col items-center justify-center text-center border transition-all overflow-hidden relative active:scale-95 ${cursorIndex === i ? 'cursor-active border-brand-red ring-8 ring-brand-red/20 shadow-2xl shadow-brand-red/40 z-10' : 'border-zinc-900 shadow-lg'} ${flippingGenreId === genre.id ? 'coin-flip' : ''}`}
                >
                  {/* Background Cover Image */}
                  <div className="absolute inset-0 z-0">
                    {genre.cover_url ? (
                      <img 
                        src={getFullUrl(genre.cover_url)}
                        className="w-full h-full object-cover transition-opacity duration-300"
                        alt=""
                        onError={(e) => { e.currentTarget.style.display = 'none'; }}
                        referrerPolicy="no-referrer"
                      />
                    ) : (
                       <div className="w-full h-full bg-zinc-900/50" />
                    )}
                    <div className={`absolute inset-0 transition-opacity ${cursorIndex === i ? 'bg-black/20' : 'bg-gradient-to-t from-black/60 to-transparent'}`} />
                  </div>

                  {/* Content */}
                  <div className="relative z-10 p-6 flex flex-col items-center w-full h-full justify-center">
                    {!genre.cover_url && (
                      <>
                        <div className={`w-20 h-20 rounded-3xl flex items-center justify-center mb-6 transition-all shadow-xl ${cursorIndex === i ? 'bg-brand-red text-white rotate-6' : 'bg-white/10 text-white backdrop-blur-md'}`}>
                          <Music className="w-10 h-10" />
                        </div>
                        <span className="text-2xl font-black italic tracking-tighter uppercase">{genre.name}</span>
                        <span className="text-[10px] font-black text-brand-red tracking-[0.3em] mt-2 bg-brand-red/10 px-3 py-1 rounded-full">{genre.playlists.length} DVD'S</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
              </div>
            </div>
            <Footer active="genres" setScreen={setScreen} queueCount={queue.length} onTerms={() => setShowTermsModal(true)} />
          </motion.div>
        )}

        {/* --- DVDS SCREEN --- */}
        {screen === 'dvds' && (
          <motion.div 
            key="dvds"
            initial={{ x: 200, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            className="flex-1 min-h-0 flex flex-col"
          >
            <Header title={selectedGenre?.name || "DVD's"} credits={credits} onBack={() => setScreen('genres')} />
            <div 
              ref={dvdsListRef}
              className="touch-scroll flex-1 min-h-0 overflow-y-auto no-scrollbar"
            >
              <div className="p-4 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 items-start">
              {(() => {
                const playlists = selectedGenre?.playlists || [];
                const dvdsMap: Record<string, any> = {};
                
                playlists.forEach((p: any, idx) => {
                  const dvdId = p.dvd_id || p.album_id || p.id || p.pk || `dv-${idx}`;
                  const dvdName = p.dvd_name || p.album_name || p.name || p.nome || p.title || p.titulo || p.album || selectedGenre?.name || "DVD";
                  const dvdCover = p.dvd_cover || p.album_cover || p.cover || p.cover_url || p.thumb || p.thumbnail || p.capa || "";
                  
                  if (!dvdsMap[dvdId]) {
                    dvdsMap[dvdId] = {
                      id: dvdId,
                      name: dvdName,
                      cover: dvdCover,
                      artist: p.artist || p.artista || p.author || p.author_name || (p.songs && p.songs.length > 0 ? p.songs[0].artist : "Vários Artistas"),
                      songs: []
                    };
                  }
                  
                  // Tenta encontrar músicas em vários campos possíveis
                  const rawPSongs = p.songs || p.musicas || p.items || p.videos || p.tracks || [];
                  const pSongs = Array.isArray(rawPSongs) ? rawPSongs : Object.values(rawPSongs);
                  
                  if (Array.isArray(pSongs) && pSongs.length > 0) {
                    pSongs.forEach((newSong: any) => {
                      if (!dvdsMap[dvdId].songs.find((s: any) => s.id === newSong.id)) {
                        // Normalizar campos de vídeo
                        const song = {
                          ...newSong,
                          id: newSong.id || newSong.pk || Math.random().toString(36).substring(7),
                          title: newSong.title || newSong.titulo || newSong.name || newSong.nome || "Música sem título",
                          artist: newSong.artist || newSong.artista || dvdsMap[dvdId].artist,
                          youtube_id: newSong.youtube_id || newSong.yt_id || newSong.youtube_url?.split('v=')?.[1] || newSong.youtube_url?.split('/')?.pop(),
                          video_url: newSong.video_url || newSong.url_video || newSong.url_flash
                        };
                        dvdsMap[dvdId].songs.push(song);
                      }
                    });
                  } else if (p.title || p.titulo || p.name || p.nome) {
                    // Trata o próprio P como uma música se tiver título e não tiver lista de sub-músicas
                    if (!dvdsMap[dvdId].songs.find((s: any) => s.id === p.id)) {
                      const song = {
                        ...p,
                        id: p.id || p.pk || Math.random().toString(36).substring(7),
                        title: p.title || p.titulo || p.name || p.nome,
                        artist: p.artist || p.artista || dvdsMap[dvdId].artist,
                        youtube_id: p.youtube_id || p.yt_id || p.youtube_url?.split('v=')?.[1] || p.youtube_url?.split('/')?.pop(),
                        video_url: p.video_url || p.url_video || p.url_flash
                      };
                      dvdsMap[dvdId].songs.push(song);
                    }
                  }
                });

                const dvdsList = Object.values(dvdsMap);
                
                if (dvdsList.length === 0) {
                  return (
                    <div className="col-span-full flex flex-col items-center justify-center p-12 opacity-50">
                      <Disc className="w-12 h-12 mb-4" />
                      <p className="font-bold uppercase tracking-widest text-sm">Nenhum DVD disponível</p>
                    </div>
                  );
                }

                return dvdsList.map((dvd: any, i) => (
                  <div 
                    key={dvd.id}
                    onClick={() => { setSelectedDVD(dvd); setScreen('songs'); }}
                    className={`selectable-item aspect-[4/3] bg-brand-surface rounded-3xl overflow-hidden border transition-all relative flex flex-col active:scale-95 ${cursorIndex === i ? 'cursor-active border-brand-red ring-4 ring-brand-red/20 z-10' : 'border-zinc-900'}`}
                  >
                    <div className="flex-1 bg-zinc-900 flex items-center justify-center relative shadow-inner">
                      {dvd.cover ? (
                        <img 
                          src={getFullUrl(dvd.cover)} 
                          alt={dvd.name} 
                          className="w-full h-full object-cover" 
                          onError={(e) => (e.currentTarget.src = "")}
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <Disc className="w-12 h-12 text-zinc-800" />
                      )}
                    </div>
                    <div className={`p-4 transition-colors ${cursorIndex === i ? 'bg-brand-red text-white' : 'bg-brand-surface'}`}>
                      <span className="text-sm font-black block truncate mb-0.5">{dvd.name.toUpperCase()}</span>
                      <span className={`text-[11px] font-black uppercase truncate block mb-1 ${cursorIndex === i ? 'text-white' : 'text-zinc-400'}`}>{dvd.artist}</span>
                      <span className={`text-[9px] font-black uppercase tracking-widest ${cursorIndex === i ? 'text-white/70' : 'text-brand-red'}`}>{dvd.songs.length} CANÇÕES</span>
                    </div>
                  </div>
                ));
              })()}
              </div>
            </div>
          </motion.div>
        )}

        {/* --- SONGS SCREEN --- */}
        {screen === 'songs' && (
          <motion.div 
            key="songs"
            initial={{ x: 200, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            className="flex-1 min-h-0 flex flex-col"
          >
            <Header title={selectedDVD?.name || "Músicas"} credits={credits} onBack={() => setScreen('dvds')} />
            <div 
              ref={songsListRef}
              className="touch-scroll flex-1 min-h-0 overflow-y-auto px-4 divide-y divide-zinc-900 no-scrollbar"
            >
              {selectedDVD && selectedDVD.songs && selectedDVD.songs.length > 0 ? (
                selectedDVD.songs.map((song, i) => (
                  <div 
                    key={song.id || `song-${i}`}
                    onClick={() => playNow(song)}
                    className={`selectable-item p-4 flex items-center gap-4 transition-all duration-150 cursor-pointer ${cursorIndex === i ? 'cursor-active bg-zinc-900 scale-[1.02] border-l-4 border-brand-red' : ''}`}
                  >
                    <div className={`w-8 h-8 flex items-center justify-center font-bold text-sm rounded ${cursorIndex === i ? 'bg-brand-red text-white' : 'text-zinc-600'}`}>
                      {i + 1}
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className={`font-bold truncate text-base ${cursorIndex === i ? 'text-white' : 'text-zinc-300'}`}>{song.title}</h3>
                      <p className={`text-xs truncate font-bold uppercase tracking-wider ${cursorIndex === i ? 'text-brand-red' : 'text-zinc-500'}`}>{song.artist}</p>
                    </div>
                    <div className="flex gap-2">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-all ${cursorIndex === i ? 'bg-brand-red text-white' : 'bg-zinc-800 text-zinc-600'}`}>
                        <Play className="w-4 h-4 fill-current" />
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center p-12 text-center opacity-50">
                  <Music className="w-12 h-12 mb-4 text-zinc-700" />
                  <p className="text-zinc-500 font-bold uppercase tracking-widest text-sm">Nenhuma música encontrada neste DVD</p>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* --- PLAYING SCREEN --- */}
        {screen === 'playing' && (
          <motion.div 
            key="playing"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className={`flex-1 flex flex-col bg-black ${currentPlaying?.youtube_id ? 'fixed inset-0 z-50' : ''}`}
          >
              <div 
                className="flex-1 flex items-center justify-center relative bg-black group"
                onClick={(e) => {
                  if (!currentPlaying?.youtube_id) return;
                  // Secret gesture: 5 taps logic
                  setTapCount(prev => {
                    const next = prev + 1;
                    if (next >= 5) {
                      setKaraokeModeActive(false);
                      setCurrentPlaying(null);
                      setScreen('genres');
                      return 0;
                    }
                    return next;
                  });
                  // Force playback on tap
                  if (ytPlayerRef.current) {
                    try {
                      ytPlayerRef.current.playVideo();
                    } catch (e) {}
                  }
                  // Reset tap count after 2 seconds of inactivity
                  setTimeout(() => setTapCount(0), 2000);
                }}
              >
                 {isAttractMode && (
                   <div className="absolute top-4 left-4 z-20 bg-brand-red px-4 py-1 rounded-full text-[10px] font-black italic tracking-widest text-white shadow-lg animate-pulse">
                     MODO DEMONSTRAÇÃO
                   </div>
                 )}
                 {karaokeModeActive && (
                   <div className="absolute top-4 right-4 z-20 bg-black/70 border border-brand-red/50 px-4 py-2 rounded-2xl text-[10px] font-black tracking-widest text-brand-red shadow-lg">
                     🎤 KARAOKÊ ATIVO
                   </div>
                 )}
               {currentPlaying?.video_url ? (
                 <video 
                   className="w-full h-full object-contain"
                   src={currentPlaying.video_url}
                   autoPlay
                   controls={false}
                   onEnded={() => {
                     if (karaokeFinishLockRef.current || screenRef.current === 'karaoke_score') {
                       return;
                     }
                     if (karaokeModeActiveRef.current) {
                       finishKaraokeSong();
                       return;
                     }
                     if (queue.length > 0) {
                       const next = queue[0];
                       setQueue(prev => prev.slice(1));
                       setCurrentPlaying(next);
                     } else {
                       setCurrentPlaying(null);
                       setScreen('genres');
                     }
                   }}
                 />
               ) : !currentPlaying?.youtube_id && (
                 <div className="w-full aspect-video bg-zinc-900 flex flex-col items-center justify-center gap-4">
                    <Disc className="w-16 h-16 text-zinc-800 animate-spin" />
                    <p className="text-zinc-700 font-mono text-xs tracking-widest uppercase">Aguardando Mídia...</p>
                 </div>
               )}

               {/* Only show info overlay if NOT a YouTube video in fullscreen mode or if user interaction occurs */}
               {(!currentPlaying?.youtube_id) && (
                 <div className="absolute bottom-0 left-0 right-0 p-8 bg-gradient-to-t from-black via-black/80 to-transparent pointer-events-none">
                    <div className="flex items-center gap-3 mb-2">
                      <div className="h-1 w-12 bg-brand-red rounded-full"></div>
                      <p className="text-brand-red font-bold text-xs tracking-[0.2em]">{isAttractMode ? 'MODO DEMONSTRAÇÃO' : 'REPRODUZINDO AGORA'}</p>
                    </div>
                    <h2 className="text-4xl font-bold mb-1 tracking-tight">{currentPlaying?.title}</h2>
                    <p className="text-zinc-400 text-xl font-medium">{currentPlaying?.artist}</p>
                 </div>
               )}
            </div>

            {/* Hide footer if playing YouTube video in true fullscreen */}
            {!currentPlaying?.youtube_id && (
              <div className="p-8 bg-brand-dark flex items-center justify-around border-t border-zinc-900 relative z-50">
                  <button 
                    onClick={() => { karaokeFinishLockRef.current = false; activeKaraokeSongRef.current = null; setKaraokeModeActive(false); setCurrentPlaying(null); setScreen('genres'); }}
                    className="flex flex-col items-center gap-2"
                  >
                    <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-white active:bg-brand-red active:border-brand-red transition-all">
                      <Square className="w-6 h-6 fill-current" />
                    </div>
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">PARAR</span>
                  </button>

                  <button 
                    onClick={() => setScreen('queue')}
                    className="flex flex-col items-center gap-2"
                  >
                    <div className="w-16 h-16 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center text-white active:scale-95 transition-all">
                      <ListMusic className="w-6 h-6" />
                    </div>
                    <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest">FILA ({queue.length})</span>
                  </button>
              </div>
            )}
          </motion.div>
        )}


        {/* --- KARAOKE SCORE SCREEN --- */}
        {screen === 'karaoke_score' && (
          <motion.div
            key="karaoke_score"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex-1 min-h-0 bg-black flex flex-col items-center justify-center p-6 text-center overflow-hidden"
          >
            <div className="w-full max-w-4xl rounded-[2.5rem] overflow-hidden border border-zinc-800 bg-zinc-950 shadow-2xl">
              <div className="relative min-h-[260px] bg-gradient-to-r from-black via-amber-950/60 to-black flex items-center justify-center p-8">
                <div className="absolute inset-0 opacity-30 bg-[radial-gradient(circle_at_center,#f59e0b_0%,transparent_55%)]" />
                <div className="relative z-10 flex flex-col md:flex-row items-center justify-center gap-8 w-full">
                  <div className="w-28 h-28 md:w-36 md:h-36 rounded-full bg-zinc-900 border-4 border-amber-500 flex items-center justify-center shadow-2xl shadow-amber-500/30">
                    <Music className="w-16 h-16 md:w-20 md:h-20 text-amber-300" />
                  </div>
                  <div>
                    <h1 className="text-3xl md:text-5xl font-black uppercase tracking-wider text-white drop-shadow-[0_3px_0_rgba(0,0,0,0.9)]">
                      Pontuação
                    </h1>
                    <div className="mt-4 bg-white text-black rounded-3xl border-4 border-zinc-900 px-10 py-5 min-w-[220px] shadow-xl">
                      <div className="text-7xl md:text-8xl font-black tabular-nums leading-none">
                        {String(karaokeDisplayScore).padStart(2, '0')}
                      </div>
                      <div className="text-[10px] font-black uppercase tracking-widest mt-2">
                        {karaokePhase === 'rolling' ? 'Calculando...' : karaokeScore >= 70 ? 'Mandou muito!' : karaokeScore >= 40 ? 'Na média!' : 'Tente novamente!'}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {karaokePhase === 'result' && (
                <div className="p-5 md:p-7 bg-zinc-950 border-t border-zinc-800">
                  <h2 className="text-white font-black uppercase tracking-[0.2em] text-xs mb-3">Resultado pronto</h2>
                  <p className="text-zinc-400 text-sm mb-2">A nota final fica na tela por <b className="text-brand-red">15 segundos</b>.</p>
                  <p className="text-zinc-500 text-xs uppercase tracking-widest">Depois disso abre o rank automaticamente.</p>
                </div>
              )}

              {karaokePhase === 'name' && (
                <div className="p-5 md:p-7 bg-zinc-950 border-t border-zinc-800">
                  <h2 className="text-brand-red font-black uppercase tracking-[0.2em] text-xs mb-3">Digite seu nome para o Rank</h2>
                  <div className="mx-auto max-w-md bg-black border border-zinc-800 rounded-2xl p-4 text-3xl font-black tracking-widest min-h-[70px] flex items-center justify-center">
                    {karaokeName || <span className="text-zinc-700 text-lg">SEU NOME</span>}
                  </div>
                  <div className="mx-auto max-w-2xl grid grid-cols-7 gap-2 mt-5">
                    {[...KARAOKE_KEYS, 'DEL', 'OK'].map((key, idx) => (
                      <button
                        key={key + idx}
                        onClick={() => handleKaraokeKey(key)}
                        className={`h-12 rounded-xl font-black text-sm border transition-all ${karaokeKeyboardIndex === idx ? 'bg-brand-red text-white border-brand-red scale-105 shadow-lg shadow-brand-red/30' : 'bg-zinc-900 text-zinc-300 border-zinc-800 active:bg-zinc-800'}`}
                      >
                        {key === ' ' ? 'ESP' : key}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-zinc-600 mt-3 uppercase tracking-widest">Setas movem • Enter confirma • OK salva</p>
                </div>
              )}

              {karaokePhase === 'saved' && (
                <div className="p-5 md:p-7 bg-zinc-950 border-t border-zinc-800">
                  <h2 className="text-white font-black uppercase tracking-[0.2em] text-xs mb-4">Top 10 Karaokê</h2>
                  <div className="grid gap-2 max-w-2xl mx-auto">
                    {karaokeRank.slice(0, 10).map((r, i) => (
                      <div key={`${r.name}-${r.date}-${i}`} className="flex items-center justify-between bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3">
                        <div className="flex items-center gap-3">
                          <span className={`w-8 h-8 rounded-lg flex items-center justify-center font-black ${i === 0 ? 'bg-amber-500 text-black' : 'bg-zinc-800 text-zinc-400'}`}>{i + 1}</span>
                          <span className="font-black uppercase">{r.name}</span>
                        </div>
                        <span className="text-brand-red text-2xl font-black tabular-nums">{String(r.score).padStart(2, '0')}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-zinc-500 text-xs uppercase tracking-widest mt-5">Voltando ao catálogo automaticamente em 15 segundos...</p>
                  <button
                    onClick={returnFromKaraokeToGenres}
                    className="mt-4 bg-brand-red px-10 py-4 rounded-2xl font-black uppercase tracking-widest text-xs shadow-xl shadow-brand-red/20"
                  >
                    Voltar ao catálogo agora
                  </button>
                </div>
              )}
            </div>
          </motion.div>
        )}

        {/* --- PIX SCREEN --- */}
        {screen === 'pix' && (
          <motion.div 
            key="pix"
            initial={{ y: 300, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="flex-1 flex flex-col p-8 items-center justify-center"
          >
            <div className="w-full max-w-sm bg-brand-surface rounded-3xl p-8 border border-zinc-900 text-center shadow-2xl">
              <div className="w-20 h-20 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                <CreditCard className="w-10 h-10 text-emerald-400" />
              </div>
              <h2 className="text-2xl font-bold mb-2">Comprar Créditos</h2>
              <p className="text-zinc-500 text-sm mb-8 leading-relaxed">Escaneie o QR Code abaixo para adicionar 2 créditos na máquina.</p>
              
              <div className="bg-white p-4 rounded-3xl mb-8 flex items-center justify-center aspect-square shadow-inner relative overflow-hidden">
                {isLoading ? (
                  <div className="flex flex-col items-center gap-4">
                    <RefreshCw className="w-12 h-12 text-zinc-300 animate-spin" />
                    <p className="text-[10px] text-zinc-400 font-bold uppercase tracking-widest text-center">Gerando cobrança...</p>
                  </div>
                ) : pixData ? (
                  <div className="w-full h-full flex flex-col items-center justify-center p-2">
                    <div className="relative w-full h-full flex items-center justify-center">
                      {(() => {
                        const qrValue = pixData.qr_code_64 || pixData.qr_code_base64 || pixData.qr_code;
                        const isBase64 = qrValue && (qrValue.startsWith('data:image') || qrValue.length > 1000);
                        
                        if (isBase64) {
                          return (
                            <img 
                              src={qrValue.startsWith('data:') ? qrValue : `data:image/png;base64,${qrValue}`} 
                              className="w-full h-full object-contain"
                              alt="QR Code PIX"
                            />
                          );
                        }
                        
                        return (
                          <QRCodeSVG 
                            value={pixData.copy_paste || pixData.qr_code || "pix"} 
                            level="L" // Lower level for very long strings
                            size={180}
                            includeMargin={false}
                          />
                        );
                      })()}
                    </div>
                    {/* Indicador de Polling */}
                    <div className="absolute bottom-2 flex items-center gap-2">
                       <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                       <span className="text-[8px] font-black text-zinc-400 uppercase tracking-tighter">AGUARDANDO PAGAMENTO...</span>
                    </div>
                  </div>
                ) : (
                   <button onClick={generatePix} className="text-zinc-400 text-xs font-bold underline px-4">ERRO AO GERAR QR CODE. TENTAR NOVAMENTE</button>
                )}
              </div>

              {pixData && (
                <div className="mb-6 p-4 bg-zinc-900 rounded-xl border border-zinc-800 text-left">
                  <p className="text-[9px] text-zinc-500 font-black mb-1 uppercase tracking-tighter">Código Copia e Cola:</p>
                  <p className="text-[10px] break-all text-emerald-500 font-mono leading-tight">
                    {(pixData.copy_paste || pixData.qr_code || "").substring(0, 80)}...
                  </p>
                </div>
              )}

              <div className="flex flex-col gap-3">
                <button 
                  onClick={() => { setPixData(null); setScreen('genres'); }}
                  className="w-full bg-zinc-800 text-zinc-400 py-4 rounded-xl font-bold text-sm hover:text-white active:scale-95 transition-all"
                >
                  CANCELAR E VOLTAR
                </button>
              </div>
            </div>
          </motion.div>
        )}

        {/* --- QUEUE SCREEN --- */}
        {screen === 'queue' && (
          <motion.div 
            key="queue"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex-1 min-h-0 flex flex-col"
          >
            <Header title="Fila de Reprodução" credits={credits} onBack={() => currentPlaying ? setScreen('playing') : setScreen('genres')} />
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {queue.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-12 text-zinc-800 text-center">
                  <ListMusic className="w-20 h-20 mb-6 opacity-20" />
                  <p className="font-bold text-zinc-600">A fila de espera está vazia</p>
                  <p className="text-zinc-700 text-sm mt-1 mb-8">Volte ao catálogo e adicione suas canções favoritas.</p>
                  <button onClick={() => setScreen('genres')} className="bg-zinc-900 px-8 py-3 rounded-full text-xs font-bold border border-zinc-800">PESQUISAR MÚSICAS</button>
                </div>
              ) : (
                queue.map((song, i) => (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    key={i} 
                    className="bg-brand-surface p-4 rounded-2xl flex items-center gap-4 border border-zinc-900 shadow-sm"
                  >
                    <span className="w-6 text-zinc-700 font-black text-xs">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold truncate text-base">{song.title}</p>
                      <p className="text-xs text-brand-red font-bold uppercase">{song.artist}</p>
                    </div>
                    <button onClick={() => setQueue(prev => prev.filter((_, idx) => idx !== i))} className="p-2 text-zinc-700 hover:text-red-500">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </motion.div>
                ))
              )}
            </div>
          </motion.div>
        )}

        {/* --- ADMIN SCREEN --- */}
        {screen === 'admin' && (
          <motion.div 
            key="admin"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="flex-1 flex flex-col p-6 overflow-y-auto"
          >
            <div className="flex items-center justify-between mb-8">
              <h2 className="text-2xl font-bold flex items-center gap-3">
                <Settings className="text-brand-red w-7 h-7" /> Configurações
              </h2>
              <button 
                onClick={() => setScreen('welcome')}
                className="w-10 h-10 bg-zinc-900 rounded-full flex items-center justify-center"
              >
                <X />
              </button>
            </div>

            <div className="space-y-6">
              <section className="space-y-4">
                <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest pl-1">Configuração do Sistema</h3>
                <div className="space-y-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-zinc-600 uppercase ml-1">URL do Servidor (MajuBox Control)</label>
                    <input 
                      type="text" 
                      value={serverUrlInput} 
                      onChange={(e) => setServerUrlInput(e.target.value)}
                      placeholder="https://sua-url.com"
                      className="w-full bg-zinc-900 border border-zinc-800 p-4 rounded-2xl outline-none focus:border-brand-red transition-all"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-zinc-600 uppercase ml-1">Token de Acesso (Gerado Automático)</label>
                    <input 
                      type="text" 
                      value={tokenInput} 
                      onChange={(e) => setTokenInput(e.target.value)}
                      placeholder="Insira o seu token"
                      className="w-full bg-zinc-900 border border-zinc-800 p-4 rounded-2xl outline-none focus:border-zinc-700 transition-all text-zinc-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-zinc-600 uppercase ml-1">Mercado Pago Token (Para Créditos)</label>
                    <input 
                      type="password" 
                      value={mpTokenInput} 
                      onChange={(e) => setMpTokenInput(e.target.value)}
                      placeholder="APP_USR-..."
                      className="w-full bg-zinc-900 border border-zinc-800 p-4 rounded-2xl outline-none focus:border-brand-red transition-all"
                    />
                    <p className="text-[9px] text-zinc-600 px-1 italic">Cada máquina usa sua própria chave de créditos.</p>
                  </div>

                  <button 
                    onClick={async () => {
                      setServerUrl(serverUrlInput);
                      setToken(tokenInput);
                      setMpToken(mpTokenInput);
                      await saveConfig({ serverUrl: serverUrlInput, token: tokenInput, mpToken: mpTokenInput });
                      alert("Configurações salvas localmente!");
                      setTimeout(() => syncWithServer(), 100);
                    }}
                    className="w-full bg-emerald-600/20 text-emerald-500 py-4 rounded-2xl font-bold text-xs uppercase tracking-widest border border-emerald-500/30 hover:bg-emerald-600 hover:text-white transition-all shadow-lg"
                  >
                    SALVAR E CONECTAR
                  </button>
                </div>
              </section>

              <section className="space-y-4 pt-4 border-t border-zinc-800">
                <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest pl-1">Importar Conteúdo (YouTube)</h3>
                <div className="bg-zinc-900/50 p-6 rounded-3xl border border-zinc-800 space-y-4">
                   <div className="space-y-1">
                      <label className="text-[10px] font-bold text-zinc-600 uppercase ml-1">Link do Canal ou @Handle</label>
                      <input id="yt-channel-input" type="text" placeholder="https://youtube.com/@DiegoeVictorHugo" className="w-full bg-black/40 border border-zinc-800 p-3 rounded-xl text-sm" />
                   </div>
                   <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-zinc-600 uppercase ml-1">Gênero</label>
                        <select id="yt-genre-input" className="w-full bg-black/40 border border-zinc-800 p-3 rounded-xl text-sm text-white outline-none focus:border-red-500">
                          <option value="">Selecione...</option>
                          {genres.map(g => (
                            <option key={g.id} value={g.id}>{g.name}</option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold text-zinc-600 uppercase ml-1">Max Vídeos</label>
                        <input id="yt-limit-input" type="number" defaultValue="50" className="w-full bg-black/40 border border-zinc-800 p-3 rounded-xl text-sm" />
                      </div>
                   </div>
                   <button 
                    onClick={async () => {
                      const channel = (document.getElementById('yt-channel-input') as HTMLInputElement).value;
                      const genreId = (document.getElementById('yt-genre-input') as HTMLInputElement).value;
                      const limit = (document.getElementById('yt-limit-input') as HTMLInputElement).value;
                      if (!channel || !genreId) return alert("Preencha canal e gênero!");
                      setIsLoading(true);
                      try {
                        const res = await api.post(getFullUrl('/api/machine/youtube/import_channel'), {
                          token,
                          hwid,
                          channel_url: channel,
                          genre_id: parseInt(genreId),
                          max_results: parseInt(limit),
                          serverUrl: serverUrlInput
                        });
                        alert(res.data.ok ? `Sucesso! Importados ${res.data.inserted} vídeos.` : `Erro: ${res.data.error}`);
                        syncWithServer();
                      } catch (e: any) {
                        alert("Erro na importação: " + (e.response?.data?.error || e.message));
                      } finally {
                        setIsLoading(false);
                      }
                    }}
                    className="w-full bg-red-600/20 text-red-500 py-3 rounded-xl font-bold text-[10px] uppercase tracking-widest border border-red-500/30 hover:bg-red-600 hover:text-white transition-all"
                   >
                    IMPORTAR AGORA
                   </button>
                   <p className="text-[9px] text-zinc-600 italic leading-relaxed">Isso criará um novo DVD no gênero selecionado com os vídeos do canal (limite 7 min).</p>
                </div>
              </section>

              <section className="space-y-4 pt-4 border-t border-zinc-800">
                <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest pl-1">Gerenciar Gêneros</h3>
                <div className="bg-zinc-900/50 p-6 rounded-3xl border border-zinc-800 space-y-6">
                   {/* Add Genre */}
                   <div className="space-y-3">
                      <p className="text-[10px] font-black text-zinc-400 uppercase tracking-widest">Adicionar Novo Gênero</p>
                      <div className="flex gap-2">
                        <input id="manual-genre-name" type="text" placeholder="Nome do Gênero" className="flex-1 bg-black/40 border border-zinc-800 p-3 rounded-xl text-sm" />
                        <button 
                          onClick={async () => {
                            const name = (document.getElementById('manual-genre-name') as HTMLInputElement).value;
                            if (!name) return;
                            setIsLoading(true);
                            try {
                              // Python server uses /admin/api/genres for creating
                              const res = await api.post(getFullUrl('/admin/api/genres'), { name, serverUrl: serverUrlInput });
                              if (res.data.message === "Gênero já existe") {
                                alert("Este gênero já está cadastrado no servidor.");
                              } else if (res.data.ok) {
                                alert("Gênero criado com sucesso!");
                                (document.getElementById('manual-genre-name') as HTMLInputElement).value = "";
                                syncWithServer();
                              } else {
                                alert("Erro: " + (res.data.error || "Verifique se está logado no painel central"));
                              }
                            } catch (e: any) {
                              alert("Erro: " + (e.response?.data?.error || e.message));
                            } finally {
                              setIsLoading(false);
                            }
                          }}
                          className="bg-brand-red text-white px-6 rounded-xl font-bold text-xs"
                        >
                          ADICIONAR
                        </button>
                      </div>
                      <p className="text-[9px] text-zinc-600 italic">As capas dos gêneros são gerenciadas pelo administrador no servidor.</p>
                   </div>
                </div>
              </section>

              <section className="space-y-4">
                <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest pl-1">Informações do Dispositivo</h3>
                <div className="grid grid-cols-2 gap-4">
                  <AdminItem label="Hardware ID" value={hwid.substring(0, 12)} />
                  <AdminItem label="Dinheiro Manual" value={`R$ ${cashRevenue.toFixed(2)}`} />
                  <AdminItem label="PIX" value={`R$ ${totalRevenue.toFixed(2)}`} />
                  <AdminItem label="Total Geral" value={`R$ ${getTotalRevenue().toFixed(2)}`} />
                </div>
                
                <div className="p-4 bg-zinc-900/50 rounded-2xl border border-zinc-900 text-[10px] space-y-2">
                  <p className="text-zinc-500 font-bold uppercase tracking-widest border-b border-zinc-900 pb-1 flex items-center gap-2">
                    <Settings className="w-3 h-3" /> Checklist APK / Android
                  </p>
                  <ul className="space-y-1 text-zinc-600 list-disc pl-3">
                    <li>No Android Studio: adicione <code className="text-zinc-400">INTERNET</code> permission no <code className="text-zinc-400">AndroidManifest.xml</code></li>
                    <li>No Servidor (Render): habilite o <code className="text-zinc-400">flask-cors</code> para permitir chamadas do APK.</li>
                    <li>Se der "Network Error", o servidor recusou a conexão ou o celular está sem internet.</li>
                  </ul>
                  <button 
                    onClick={() => {
                      syncWithServer();
                      setShowDebug(true);
                    }}
                    className="w-full mt-2 bg-zinc-800 py-2 rounded-xl text-zinc-400 font-bold hover:text-white"
                  >
                    TESTAR CONEXÃO AGORA
                  </button>
                </div>
              </section>

              <section className="grid grid-cols-2 gap-4">
                 <button 
                   onClick={resetCredits}
                   className="bg-zinc-900 border border-zinc-800 py-4 rounded-2xl font-bold text-xs flex flex-col items-center gap-2 hover:bg-zinc-800"
                 >
                   <RefreshCw className="w-4 h-4 text-zinc-500" /> ZERAR CRÉDITOS
                 </button>
                 <button 
                   onClick={resetRevenue}
                   className="bg-zinc-900 border border-zinc-800 py-4 rounded-2xl font-bold text-xs flex flex-col items-center gap-2 hover:bg-zinc-800"
                 >
                   <Trash2 className="w-4 h-4 text-zinc-500" /> ZERAR CONTADOR
                 </button>
              </section>

              <button 
                onClick={saveSettings}
                className="w-full bg-brand-red py-5 rounded-2xl font-bold shadow-xl shadow-brand-red/20 text-lg active:scale-95 transition-all"
              >
                SALVAR E CONECTAR
              </button>
            </div>
          </motion.div>
        )}

        {/* --- READING SCREEN (MENU NO 5) --- */}
        {screen === 'reading' && (
          <motion.div 
            key="reading"
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex-1 flex flex-col p-8 items-center justify-center bg-zinc-950"
          >
            <div className="w-full max-w-md bg-brand-surface border border-zinc-900 rounded-[2.5rem] p-10 text-center shadow-2xl">
               <div className="w-20 h-20 bg-emerald-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
                  <RefreshCw className="w-10 h-10 text-emerald-500" />
               </div>
               <h2 className="text-3xl font-black mb-1 italic tracking-tighter">LEITURA TÉCNICA</h2>
               <p className="text-zinc-600 text-xs font-bold uppercase tracking-[0.3em] mb-10">MajuBox Control v2.4</p>
               
               <div className="grid grid-cols-1 gap-4 text-left mb-10">
                  <div className="p-5 bg-zinc-900 rounded-3xl border border-zinc-800 flex justify-between items-center">
                    <span className="text-zinc-500 font-bold text-xs uppercase">Dinheiro Manual</span>
                    <span className="text-2xl font-black text-yellow-400">R$ {cashRevenue.toFixed(2)}</span>
                  </div>
                  <div className="p-5 bg-zinc-900 rounded-3xl border border-zinc-800 flex justify-between items-center">
                    <span className="text-zinc-500 font-bold text-xs uppercase">Entradas R$ (PIX)</span>
                    <span className="text-2xl font-black text-emerald-400">R$ {totalRevenue.toFixed(2)}</span>
                  </div>
                  <div className="p-5 bg-zinc-900 rounded-3xl border border-zinc-800 flex justify-between items-center">
                    <span className="text-zinc-500 font-bold text-xs uppercase">Total Geral</span>
                    <span className="text-2xl font-black text-white">R$ {getTotalRevenue().toFixed(2)}</span>
                  </div>
                  <div className="p-5 bg-zinc-900 rounded-3xl border border-zinc-800 flex justify-between items-center">
                    <span className="text-zinc-500 font-bold text-xs uppercase">Créditos em Máquina</span>
                    <span className="text-2xl font-black text-brand-red">{credits}</span>
                  </div>
                  <div className="p-5 bg-zinc-900 rounded-3xl border border-zinc-800 flex justify-between items-center">
                    <span className="text-zinc-500 font-bold text-xs uppercase">ID Dispositivo</span>
                    <span className="text-xs font-mono text-zinc-400">{hwid}</span>
                  </div>
               </div>

               <button 
                  onClick={() => setScreen('genres')}
                  className="w-full bg-zinc-900 border border-zinc-800 py-5 rounded-3xl font-black text-xs tracking-widest active:bg-zinc-800"
               >
                  FECHAR LEITURA
               </button>
            </div>
          </motion.div>
        )}

      </AnimatePresence>

      {/* --- DEBUG MODAL --- */}
      {showDebug && (
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 z-[100] bg-black/90 p-8 overflow-y-auto text-white"
        >
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-xl font-bold text-brand-red">Logs de Depuração</h2>
            <button 
              onClick={() => setShowDebug(false)}
              className="bg-zinc-800 p-2 rounded-xl"
            >
              <X className="w-6 h-6" />
            </button>
          </div>
          
          <div className="space-y-4">
            <div className="bg-zinc-900 p-4 rounded-2xl border border-zinc-800">
              <p className="text-[10px] text-zinc-500 font-bold uppercase mb-1">Configuração Atual</p>
              <p className="text-xs font-mono break-all text-zinc-300">Server: {serverUrl}</p>
              <p className="text-xs font-mono break-all text-zinc-300">Token: {token || "Não configurado"}</p>
              <p className="text-xs font-mono break-all text-zinc-300">HWID: {hwid}</p>
            </div>

            <div className="flex gap-2">
               <button 
                 onClick={() => syncWithServer()}
                 className="flex-1 bg-brand-red py-3 rounded-xl font-bold text-xs"
               >
                 RETESTAR CONEXÃO
               </button>
               <button 
                 onClick={() => setDebugLogs([])}
                 className="bg-zinc-800 px-4 rounded-xl text-xs font-bold"
               >
                 LIMPAR
               </button>
            </div>

            <div className="bg-black p-4 rounded-2xl border border-zinc-900 h-96 overflow-y-auto font-mono text-[10px] space-y-1">
              {debugLogs.map((log, i) => (
                <div key={i} className="border-b border-zinc-900 pb-1 text-zinc-400 break-words">
                  {log}
                </div>
              ))}
              {debugLogs.length === 0 && <p className="text-zinc-700 italic">Nenhum log registrado...</p>}
            </div>

            <p className="text-center text-[10px] text-zinc-600">
              Verifique se a URL do servidor está correta e termina com .onrender.com (ex: https://maju-server.onrender.com)
            </p>
          </div>
        </motion.div>
      )}

      {/* --- TERMS MODAL --- */}
      {showTermsModal && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 z-[200] bg-black/95 p-5 md:p-10 flex items-center justify-center text-white"
        >
          <div className="w-full max-w-4xl max-h-[92vh] bg-zinc-950 border border-zinc-800 rounded-[2rem] shadow-2xl overflow-hidden flex flex-col">
            <div className="p-6 border-b border-zinc-800 flex items-center gap-4">
              <div className="w-12 h-12 rounded-2xl bg-brand-red/10 text-brand-red flex items-center justify-center">
                <ShieldCheck className="w-7 h-7" />
              </div>
              <div className="flex-1">
                <h2 className="text-xl md:text-2xl font-black uppercase tracking-tight">Termos de Uso e Contrato de Licença</h2>
                <p className="text-xs text-zinc-500 font-bold uppercase tracking-widest">MajuBox • Versão {TERMS_VERSION}</p>
              </div>
              {termsAccepted && (
                <button onClick={() => setShowTermsModal(false)} className="w-10 h-10 rounded-xl bg-zinc-900 flex items-center justify-center">
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-6 md:p-8 whitespace-pre-wrap text-sm md:text-base leading-relaxed text-zinc-300 bg-black/30">
              {TERMS_TEXT}
            </div>

            <div className="p-6 border-t border-zinc-800 bg-zinc-950">
              {!termsAccepted ? (
                <>
                  <label className="flex gap-3 items-start text-sm text-zinc-300 mb-5 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={termsChecked}
                      onChange={(e) => setTermsChecked(e.target.checked)}
                      className="mt-1 w-5 h-5 accent-red-600"
                    />
                    <span>Li e aceito os Termos de Uso e o Contrato de Licença MajuBox.</span>
                  </label>
                  <button
                    disabled={!termsChecked}
                    onClick={recordTermsAcceptance}
                    className="w-full bg-brand-red disabled:bg-zinc-800 disabled:text-zinc-500 py-4 rounded-2xl font-black text-xs tracking-widest uppercase"
                  >
                    Aceitar e Continuar
                  </button>
                </>
              ) : (
                <button
                  onClick={() => setShowTermsModal(false)}
                  className="w-full bg-zinc-900 border border-zinc-800 py-4 rounded-2xl font-black text-xs tracking-widest uppercase"
                >
                  Fechar Termos
                </button>
              )}
            </div>
          </div>
        </motion.div>
      )}

      {/* Global YouTube Player Container */}
      <div 
        className={`fixed inset-0 bg-black transition-all duration-300 ${screen === 'playing' ? 'opacity-100 z-50' : 'opacity-0 -z-50'}`}
        style={{ 
          backgroundColor: 'black'
        }}
      >
        <div className="w-full h-full relative">
           <div id="yt-player" className="w-screen h-screen"></div>
           {/* Add a invisible overlay to capture taps for our secret gesture if playing */}
           {screen === 'playing' && (
             <div 
               className="absolute inset-0 z-[60] bg-transparent" 
               onClick={(e) => {
                 setTapCount(prev => {
                    const next = prev + 1;
                    if (next >= 5) {
                      setKaraokeModeActive(false);
                      setCurrentPlaying(null);
                      setScreen('genres');
                      return 0;
                    }
                    return next;
                  });
                  // Force playback on tap
                  if (ytPlayerRef.current) {
                    try {
                      ytPlayerRef.current.playVideo();
                    } catch (e) {}
                  }
               }}
             />
           )}
        </div>
      </div>
    </div>
  );
}

// --- Sub-components ---

function Header({ title, credits, onBack, onRefresh, loading }: { title: string, credits: number, onBack: () => void, onRefresh?: () => void, loading?: boolean }) {
  return (
    <div className="p-4 flex items-center justify-between bg-brand-surface border-b border-zinc-900 sticky top-0 z-10">
      <button onClick={onBack} className="w-10 h-10 flex items-center justify-center active:bg-zinc-800 rounded-full transition-colors">
        <ChevronLeft className="w-7 h-7" />
      </button>
      <h2 className="flex-1 text-center font-black text-lg truncate px-2 tracking-tight">{title.toUpperCase()}</h2>
      <div className="flex gap-2">
        {onRefresh && (
          <button onClick={onRefresh} className={`w-10 h-10 flex items-center justify-center bg-zinc-900 rounded-xl ${loading ? 'animate-spin' : ''}`}>
             <RefreshCw className="w-4 h-4 text-zinc-500" />
          </button>
        )}
        <div className="bg-brand-red/10 px-4 py-2 rounded-xl flex items-center gap-2 border border-brand-red/20 shadow-sm">
          <span className="text-brand-red text-sm">💰</span>
          <span className="font-black text-brand-red text-base">{credits}</span>
        </div>
      </div>
    </div>
  );
}

function Footer({ active, setScreen, queueCount, onTerms }: { active: string, setScreen: (s: any) => void, queueCount: number, onTerms?: () => void }) {
  return (
    <div className="p-6 bg-brand-surface border-t border-zinc-900 grid grid-cols-4 gap-4">
      <button 
        onClick={() => setScreen('genres')}
        className={`flex flex-col items-center gap-2 transition-colors ${active === 'genres' ? 'text-brand-red' : 'text-zinc-600'}`}
      >
        <Music className="w-6 h-6" />
        <span className="text-[10px] font-black tracking-widest">CATÁLOGO</span>
      </button>
      <button 
        onClick={() => setScreen('queue')}
        className={`flex flex-col items-center gap-2 transition-colors relative ${active === 'queue' ? 'text-brand-red' : 'text-zinc-600'}`}
      >
        <ListMusic className="w-6 h-6" />
        {queueCount > 0 && <span className="absolute top-0 right-1/4 w-4 h-4 bg-brand-red text-white text-[8px] font-bold rounded-full flex items-center justify-center border-2 border-brand-surface">{queueCount}</span>}
        <span className="text-[10px] font-black tracking-widest">FILA</span>
      </button>
      <button 
        onClick={() => setScreen('pix')}
        className={`flex flex-col items-center gap-2 transition-colors ${active === 'pix' ? 'text-brand-red' : 'text-zinc-600'}`}
      >
        <CreditCard className="w-6 h-6" />
        <span className="text-[10px] font-black tracking-widest">PIX</span>
      </button>
      <button 
        onClick={() => onTerms && onTerms()}
        className="flex flex-col items-center gap-2 transition-colors text-zinc-600"
      >
        <FileText className="w-6 h-6" />
        <span className="text-[10px] font-black tracking-widest">TERMOS</span>
      </button>
    </div>
  );
}

function AdminItem({ label, value }: { label: string, value: string }) {
  return (
    <div className="p-4 bg-zinc-900 rounded-2xl flex flex-col gap-1 border border-zinc-800">
      <span className="text-zinc-600 font-bold text-[9px] uppercase tracking-widest">{label}</span>
      <span className="font-bold text-sm truncate">{value}</span>
    </div>
  );
}

