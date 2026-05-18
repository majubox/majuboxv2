import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.majubox.app',
  appName: 'MajuBox',
  webDir: 'dist',

  server: {
    androidScheme: 'https',
    cleartext: true,           // ← Muito importante
  },

  android: {
    allowMixedContent: true,   // ← Essencial
    webContentsDebuggingEnabled: true,
  },

  plugins: {
    CapacitorHttp: {
      enabled: true,           // ← Usa HTTP nativo do Android (melhor bypass de CORS)
    },
    SplashScreen: {
      launchShowDuration: 1200,
      backgroundColor: "#0a0a0c",
    },
  },
};

export default config;
