# MajuBox Web

Sistema de Jukebox Digital multiformato desenvolvido com React, Vite, Capacitor e Electron.

## 🚀 Plataformas Suportadas
Este projeto foi preparado para rodar em:
- **Web**: Navegadores modernos.
- **Android**: Aplicativo nativo via Capacitor.
- **iOS**: Aplicativo nativo via Capacitor.
- **Linux / Desktop**: Via Electron.
- **Smart TVs**: Compatibilidade com controles remotos (atalhos de teclado).

## ✨ Funcionalidades
- **Playlist e Fila**: Gerenciamento de músicas.
- **Pagamento PIX**: Integração para cobrança automática.
- **Crédito Manual**: Ativado pela tecla **"6"** no teclado ou controle remoto (útil para Smart TVs e testes).
- **Modo Atrativo (Attract Mode)**: Animações quando o sistema está ocioso.
- **Logs de Depuração**: Visualização de eventos em tempo real na tela (ajustável).

## 🛠️ Tecnologias
- **Frontend**: React 19, Tailwind CSS 4, Framer Motion.
- **Backend**: Express (Proxy para API).
- **Mobile/Desktop**: Capacitor & Electron.

## 📦 Como rodar localmente

### Pré-requisitos
- [Node.js](https://nodejs.org/) (Versão 18+)
- [npm](https://www.npmjs.com/)

### Instalação
```bash
npm install
```

### Desenvolvimento (Web)
```bash
npm run dev
```
O servidor rodará em `http://localhost:3000`.

## 🏗️ Comandos de Build

### Web
```bash
npm run build
```
Os arquivos serão gerados na pasta `dist/`.

### Android
```bash
npm run build:android
```
Após o comando, abra a pasta `android/` no **Android Studio** para gerar o APK/Bundle.

### iOS
```bash
npm run build:ios
```
Após o comando, abra a pasta `ios/App/App.xcworkspace` no **Xcode** (requer macOS).

### Linux / Desktop
```bash
npm run build:linux
```
Para rodar o Electron em modo desenvolvimento:
```bash
npx cap open electron
```

## 📺 Configuração para Smart TVs
O sistema está configurado para aceitar comandos de teclados numéricos comuns em controles remotos.
- **Inserir Crédito**: Pressione a tecla **6**.

## 🔑 Variáveis de Ambiente
Crie um arquivo `.env` na raiz do projeto seguindo o modelo do `.env.example`:
- `GEMINI_API_KEY`: Sua chave da API Gemini (para recursos de IA).
- `VITE_SERVER_URL`: URL do servidor de API remoto (se houver).

## 📄 Notas de Implantação (Web)
Para hospedar no GitHub Pages ou similar, certifique-se de que as rotas `/api/` estejam configuradas corretamente se você estiver usando o `server.ts` como proxy. Para hospedagem estática pura, as chamadas de API devem apontar diretamente para o servidor de produção através da variável `VITE_SERVER_URL`.
