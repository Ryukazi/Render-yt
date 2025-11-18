const express = require("express");
const cors = require("cors");
const ytdl = require("ytdl-core");
const { v4: uuidv4 } = require("uuid");
const { URLSearchParams } = require("url");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// In-memory job store: { id => { url, formats, createdAt } }
const JOBS = new Map();
const JOB_TTL_MS = 10 * 60 * 1000; // 10 minutes

function makeJobId() {
  return Buffer.from(uuidv4()).toString("base64url"); // URL-safe base64 id
}

// Clean old jobs periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of JOBS.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) JOBS.delete(id);
  }
}, 60 * 1000);

// Helper to approximate filesize (very rough) for display
function approxSizeByBitrate(contentLength) {
  if (!contentLength) return null;
  const bytes = parseInt(contentLength, 10);
  if (isNaN(bytes)) return null;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * ANALYZE endpoint — returns a job id and available formats
 * Mimics: POST /mates/en/analyze/ajax?...  (we'll accept POST body url)
 */
app.post("/mates/en/analyze/ajax", async (req, res) => {
  try {
    const url = req.body.url || req.query.url;
    if (!url) return res.status(400).json({ status: false, error: "Missing url" });

    if (!ytdl.validateURL(url) && !ytdl.validateID(url)) {
      // try to detect ID from url-like
      const maybeIdMatch = url.match(/[a-zA-Z0-9_-]{11}/);
      if (!maybeIdMatch) return res.json({ status: false, error: "Invalid YouTube URL/ID" });
    }

    // get video info
    const info = await ytdl.getInfo(url);

    // gather formats: pick only 'video+audio' or 'audio' or progressive
    const rawFormats = info.formats || [];
    const formats = rawFormats
      .filter(f => f.hasVideo || f.hasAudio)
      .map(f => ({
        itag: f.itag,
        mimeType: f.mimeType,
        qualityLabel: f.qualityLabel || f.audioBitrate ? `${f.audioBitrate ? f.audioBitrate + "kbps" : ""}` : "unknown",
        container: (f.container || "").toString(),
        hasVideo: !!f.hasVideo,
        hasAudio: !!f.hasAudio,
        approxSize: approxSizeByBitrate(f.contentLength || f.clen || f.contentLength)
      }));

    // Create job
    const id = makeJobId();
    JOBS.set(id, {
      id,
      url,
      info: {
        title: info.videoDetails.title,
        lengthSeconds: info.videoDetails.lengthSeconds,
        author: info.videoDetails.author && info.videoDetails.author.name,
        thumbnails: info.videoDetails.thumbnails
      },
      formats,
      createdAt: Date.now()
    });

    // Respond similar shape: include id and formats summary
    return res.json({
      status: "ok",
      id,
      video: JOBS.get(id).info,
      formats
    });
  } catch (err) {
    console.error("analyze error:", err?.message || err);
    return res.status(500).json({ status: false, error: err.message || String(err) });
  }
});

/**
 * CONVERT endpoint — takes job id and requested itag/format, returns a downloadUrl
 * Mimics POST /mates/en/convert?id=<jobId>
 */
app.post("/mates/en/convert", async (req, res) => {
  try {
    // accept id from query or body
    const jobId = req.query.id || req.body.id;
    const url = req.body.url || req.query.url;
    const itag = req.body.format || req.body.itag || req.body.fmt || req.query.format || req.query.itag;

    if (!jobId) return res.status(400).json({ status: false, error: "Missing id" });

    const job = JOBS.get(jobId);
    if (!job) return res.status(404).json({ status: false, error: "Job not found or expired" });

    // if url provided, check consistency
    if (url && url !== job.url) {
      // update job url if necessary (rare)
      job.url = url;
    }

    // if no itag provided, choose a default progressive or best video+audio
    let chosenItag = itag;
    if (!chosenItag) {
      // prefer formats with both video+audio, sort by qualityLabel
      const videoAudio = job.formats.filter(f => f.hasVideo && f.hasAudio);
      if (videoAudio.length) {
        // pick highest (last if qualityLabel sorts naturally)
        chosenItag = videoAudio[0].itag;
      } else {
        chosenItag = job.formats[0] && job.formats[0].itag;
      }
    }

    // Build a server-side download URL (points to our /download/file)
    const downloadUrl = `${req.protocol}://${req.get("host")}/download/file?id=${encodeURIComponent(jobId)}&itag=${encodeURIComponent(chosenItag)}`;

    return res.json({
      status: "success",
      downloadUrl,
      itag: chosenItag
    });
  } catch (err) {
    console.error("convert error:", err?.message || err);
    return res.status(500).json({ status: false, error: err.message || String(err) });
  }
});

/**
 * STATUS endpoint — returns a JSON with 'result' field containing HTML-like snippet (mimic)
 */
app.get("/mates/en/status", (req, res) => {
  try {
    const jobId = req.query.id;
    if (!jobId) return res.status(400).json({ status: false, error: "Missing id" });

    const job = JOBS.get(jobId);
    if (!job) return res.json({ status: false, error: "Job not found" });

    // Create small HTML snippet as string. Keep it short.
    const resultHtml = `
      <div class="result-row" style="padding:12px;border-radius:12px;background:#0f172a;color:#fff">
        <h3>${escapeHtml(job.info.title)}</h3>
        <p>By: ${escapeHtml(job.info.author || "Unknown")} • ${job.info.lengthSeconds}s</p>
        <div class="formats">
          ${job.formats.slice(0, 8).map(f => `
            <div class="fmt">itag:${f.itag} ${f.qualityLabel || ""} ${f.container || ""} ${f.hasVideo ? "V":" "}${f.hasAudio ? "A":""} ${f.approxSize || ""}</div>
          `).join("")}
        </div>
      </div>
    `;

    return res.json({ status: "success", result: resultHtml });
  } catch (err) {
    console.error("status error:", err?.message || err);
    return res.status(500).json({ status: false, error: err.message || String(err) });
  }
});

/**
 * DOWNLOAD FILE — streams ytdl to client
 * GET /download/file?id=<jobId>&itag=<itag>
 */
app.get("/download/file", async (req, res) => {
  try {
    const jobId = req.query.id;
    const itag = req.query.itag;
    if (!jobId) return res.status(400).send("Missing id");
    const job = JOBS.get(jobId);
    if (!job) return res.status(404).send("Job not found");

    const info = await ytdl.getInfo(job.url);
    const formats = info.formats;
    const format = formats.find(f => String(f.itag) === String(itag));
    if (!format) {
      return res.status(400).send("Format not available");
    }

    // Set headers for download
    const titleSafe = (info.videoDetails.title || "video").replace(/[^a-z0-9_\-\.]/gi, "_");
    const ext = format.container || "mp4";
    res.setHeader("Content-Disposition", `attachment; filename="${titleSafe}.${ext}"`);
    res.setHeader("Content-Type", format.mimeType ? format.mimeType.split(";")[0] : "application/octet-stream");

    // Stream with ytdl-core using requested itag
    const stream = ytdl(job.url, { quality: itag });
    stream.on("error", (e) => {
      console.error("stream error:", e);
      if (!res.headersSent) res.status(500).send("Stream error");
      else res.end();
    });

    stream.pipe(res);
  } catch (err) {
    console.error("download error:", err?.message || err);
    if (!res.headersSent) res.status(500).send("Server error");
    else res.end();
  }
});

// Small helper to escape HTML
function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Hana yt clone running on port ${PORT}`));
