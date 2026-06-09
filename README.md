# BMU AI Academic Advisor

An interactive talking academic advisor for **Bayelsa Medical University** students.
Built on the BMU AI Assistant foundation, with a new student-focused knowledge base, an
animated 2D advisor character that speaks (Azure TTS with visemes for lip-sync) and
listens (Azure STT), and a typewriter answer panel synced to the spoken response.

## Status

Phase 1 scaffolding only. Backend + frontend will be wired up in subsequent phases.

## Tech stack

- **Backend**: Node.js, Express, MySQL (`mysql` pool), JWT auth, Helmet, rate limiting.
- **AI**: DeepSeek (chat), Ollama `nomic-embed-text` (embeddings), FAISS vector store.
- **Voice (free-first, scales to thousands of students)**:
  - **STT**: browser Web Speech API on-device, with **Groq Whisper** as a server-side fallback.
  - **TTS**: **TTSMaker** (free tier); browser `speechSynthesis` as final fallback.
  - **Lip-sync**: amplitude-driven (Web Audio API) — no Azure dependency, works with any TTS.
- **Frontend**: Vanilla JS PWA, Lottie 2D talking avatar, typewriter answer panel.

## Topics the advisor covers

1. Programmes, courses, prerequisites, course registration
2. Academic calendar, exam timetable, important dates
3. Grading, GPA/CGPA, transcripts, withdrawal/probation rules
4. Fees, payment schedules, scholarships, bursary
5. Hostel, accommodation, transport
6. Health, counselling, student welfare
7. Library, e-resources, study skills
8. Code of conduct, complaints, escalations
9. Career guidance, internship, clinical postings

## Quick start on Windows (MAMP)

### 1. Prerequisites

| Tool | Notes |
| --- | --- |
| Node.js 18+ LTS | https://nodejs.org |
| MAMP for Windows | MySQL on port **3306** by default |
| Visual Studio Build Tools 2022 + Python 3.x | Needed to compile `bcrypt` and `faiss-node` native modules. Install the **Desktop development with C++** workload. |
| Ollama | https://ollama.com — for embeddings only |
| Git for Windows | Includes a bash shell so `*.sh` scripts still run if needed |
| (Optional) ffmpeg | If you later add audio post-processing |

### 2. Clone + install

```powershell
cd C:\MAMP\htdocs
git clone <your-fork-url> bmu-ai-academic-advisor
cd bmu-ai-academic-advisor
npm install
```

If `npm install` fails on `bcrypt` or `faiss-node`, install the Build Tools above and
retry. As a fallback you may swap `bcrypt` for `bcryptjs` (pure JS) by editing
`package.json`.

### 3. Configure environment

```powershell
Copy-Item .env.example .env
notepad .env
```

Fill in at minimum:

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` (defaults match Windows MAMP).
- `JWT_SECRET` (any long random string).
- `DEEPSEEK_API_KEY` — https://platform.deepseek.com.
- `TTSMAKER_TTS_API_KEY` — https://ttsmaker.com (free tier).
- `GROQ_API_KEY` — https://console.groq.com (free tier, ~14k req/day) — used only as STT fallback.
- `OLLAMA_URL` (default `http://127.0.0.1:11434`).
- Azure Speech keys are optional and only needed if you ever want phoneme-accurate visemes.

### 4. Set up local services

Start MAMP (MySQL). Then in another terminal:

```powershell
# Ollama: install once, then pull the embedding model
ollama pull nomic-embed-text
ollama serve   # leave running
```

### 5. Initialise the database

```powershell
npm run setup-db
```

### 6. Run the app

```powershell
npm run dev    # nodemon
# or
npm start
```

Open http://localhost:3000.

## Deployment

- macOS / Linux: `./deploy.sh`
- Windows (uses OpenSSH client): `.\deploy.ps1`

Both expect an SSH config entry named `bmu-vps` pointing at your VPS.

## Project layout

```
client/        Frontend PWA (advisor UI, Lottie avatar, typewriter panel)
config/db.js   MySQL pool (auto-picks port 3306 on Windows, 8889 on macOS)
server/
  app.js          Express bootstrap
  middleware/     auth, upload, validation
  models/         MySQL-backed model classes
  routes/         REST API routes (incl. /api/advisor — added in phase 4)
  scripts/        DB setup, migrations, seeders, smoke test
  services/       AI, retrieval, TTS, FAQ cache, vector store
uploads/        User-uploaded documents (gitignored)
docs/           Architecture + topic notes
```

## Notes for developers coming from the original BMU AI Assistant

- The MySQL default DB name is now `bmu_academic_advisor`.
- Several "VC" (Vice-Chancellor) routes and services were inherited but will be removed
  or repurposed for the academic advisor as the new endpoints land.
- Line endings are pinned via `.gitattributes` so `*.sh` stays LF on Windows checkouts.
