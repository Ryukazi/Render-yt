const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());

app.get("/", (req, res) => {
  res.send("YT API by Denish is running!");
});

app.get("/download", async (req, res) => {
  try {
    const url = req.query.url;
    const note = req.query.note || "360p";
    const format = req.query.format || "18";

    if (!url) {
      return res.json({ status: false, error: "Missing url parameter" });
    }

    // Step 1 — Analyze (Get ID)
    const analyzeRes = await axios.post(
      "https://yt1d.com/mates/en/analyze/ajax?retry=undefined&platform=youtube&mhash=12972224f183e7ef9&country=NP",
      new URLSearchParams({
        url,
        platform: "youtube"
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": "Mozilla/5.0"
        }
      }
    );

    const analyzeData = analyzeRes.data;

    if (!analyzeData.id) {
      return res.json({ status: false, error: "Cannot extract ID (Analyze failed)" });
    }

    const videoId = analyzeData.id;

    // Step 2 — Convert (Get Download Link)
    const convertRes = await axios.post(
      `https://yt1d.com/mates/en/convert?id=${encodeURIComponent(videoId)}`,
      new URLSearchParams({
        platform: "youtube",
        url,
        id: videoId,
        ext: "mp4",
        note,
        format
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": "Mozilla/5.0"
        }
      }
    );

    const convertData = convertRes.data;

    if (!convertData.status || !convertData.downloadUrl) {
      return res.json({ status: false, error: "Convert failed" });
    }

    // Success
    res.json({
      status: "success",
      downloadUrl: convertData.downloadUrl
    });

  } catch (err) {
    console.error(err.message);
    res.json({ status: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
