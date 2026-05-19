# Guia para configurar o Backend (servidor.py)

Para que o MajuBox funcione corretamente com o seu servidor Python (`juke-2.onrender.com`), o seu código deve implementar os seguintes requisitos:

## 1. CORS habilitado
O servidor deve permitir requisições de outras origens. No Flask, use `flask-cors`.

```python
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app) # Isso é fundamental!
```

## 2. Endpoints Necessários

### Handshake (Status da Máquina)
O App chama `POST /machine/check`.
Nota: Se o seu servidor não usa o prefixo `/api`, o MajuBox agora tenta remover o `/api` automaticamente via proxy se receber um erro 404.

**Request Payload:**
```json
{
  "hwid": "ID_UNICO_DA_MAQUINA",
  "token": "TOKEN_SE_JÁ_TIVER",
  "machine_name": "NOME",
  "admin_pass": "1234"
}
```

**Resposta Recomendada:**
```json
{
  "ok": true,
  "machine_id": "ABC123",
  "token": "SEU_TOKEN_GERADO",
  "license_ok": true,
  "license_exp": "2026-12-31T23:59:59Z",
  "genres": [
    {
      "id": 1,
      "name": "Sertanejo",
      "playlists": [
         { "title": "Música 1", "youtube_id": "ID_YOUTUBE", "artist": "Artista" }
      ]
    }
  ]
}
```

### Lista de Gêneros (Se não vier no check)
O App chama `GET /machine/genres`.

**Resposta Recomendada:**
```json
{
  "ok": true,
  "genres": [...]
}
```

## 3. Logs de Depuração
Se o App exibir "Resposta do servidor vazia", verifique no log do seu Render (juke-2) se a requisição está chegando.
- O MajuBox Web envia as requisições para o backend do próprio Render (majuboxv2-1), que então faz um **Proxy** para o seu `juke-2.onrender.com`.
- Isso é feito para evitar problemas de segurança e bloqueios de navegadores.

## 4. Dicas de Erros Comuns
- **Erro 404:** Verifique se as rotas no Python começam com `/machine/...` ou se você espera `/api/machine/...`. O App agora é flexível, mas o ideal é que as rotas coincidam.
- **Erro 500:** Verifique os logs do `juke-2` no painel do Render. Geralmente é erro de banco de dados ou variável ausente.
- **Resposta Vazia:** Certifique-se de que sua função Flask sempre retorna um `jsonify(...)` e nunca `None` ou uma string vazia.
