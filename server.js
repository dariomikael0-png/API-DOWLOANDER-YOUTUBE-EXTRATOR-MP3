const express = require("express");
const { execFile } = require("child_process");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());

app.use(cors()); // depois podemos restringir

const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

const jobs = {};
const queue = [];
let working = false;

function scheduleCleanup(filePath, delay = 10 * 60 * 1000) {
  setTimeout(() => {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }, delay);
}

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

function runNext() {
  if (working) return;
  const next = queue.shift();
  if (!next) return;

  working = true;

  const { id, url, format, baseUrl } = next;
  const outTemplate = path.join(downloadsDir, `${id}.%(ext)s`);

  const ytDlp = "yt-dlp";

  let args = [];
  if (format === "mp3") {
    args = ["-x", "--audio-format", "mp3", "--no-playlist", "-o", outTemplate, url];
  } else {
    args = ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/mp4", "--no-playlist", "-o", outTemplate, url];
  }

  jobs[id] = { status: "processing" };

  execFile(ytDlp, args, { timeout: 180000 }, (err) => {
    if (err) {
      jobs[id] = { status: "error", message: "Falha ao converter" };
      working = false;
      runNext();
      return;
    }

    const files = fs.readdirSync(downloadsDir);
    const file = files.find(f => f.startsWith(id));

    if (!file) {
      jobs[id] = { status: "error", message: "Arquivo não encontrado" };
      working = false;
      runNext();
      return;
    }

    const downloadUrl = `${baseUrl}/download/${encodeURIComponent(file)}`;
    jobs[id] = { status: "done", downloadUrl };

    scheduleCleanup(path.join(downloadsDir, file));

    working = false;
    runNext();
  });
}

app.post("/convert", (req, res) => {
  const { url, format } = req.body;

  if (!url) return res.status(400).json({ status: "error", message: "URL obrigatória" });
  if (!["mp3", "mp4"].includes(format)) return res.status(400).json({ status: "error", message: "Formato inválido" });

  const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/.+/;
  if (!ytRegex.test(url)) return res.status(400).json({ status: "error", message: "URL inválida" });

  const id = crypto.randomBytes(6).toString("hex");
  const baseUrl = getBaseUrl(req);

  jobs[id] = { status: "queued" };
  queue.push({ id, url, format, baseUrl });

  runNext();

  res.json({ status: "processing", id });
});

app.get("/status/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ status: "error", message: "Job não encontrado" });
  res.json(job);
});

app.use("/download", express.static(downloadsDir));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("API rodando na porta", PORT));
