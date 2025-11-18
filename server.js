import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Hana YouTube API is running on Render!");
});

// MAIN API: /download
app.get("/download", async (req, res) => {
  try {
    const { url, note = "360p", format = "18" } = req.query;

    if (!url) return res.json({ status: false, error: "Missing url parameter" });

    // Step 1: ANALYZE (POST request)
    const analyze = await axios.post(
      "https://yt1d.com/mates/en/analyze/ajax",
      new URLSearchParams({
        url,
        platform: "youtube",
        country: "NP",
        retry: "undefined",
        mhash: "12972224f183e7ef9"
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137 Mobile Safari/537.36",
          "X-Requested-With": "XMLHttpRequest",
        }
      }
    );

    // Extract ID
    const id = analyze.data.id || analyze.data?.result?.id;
    if (!id) return res.json({ status: false, error: "Cannot extract ID" });

    // Step 2: Convert
    const convert = await axios.post(
      `https://yt1d.com/mates/en/convert?id=${encodeURIComponent(id)}`,
      new URLSearchParams({
        platform: "youtube",
        url,
        id,
        ext: "mp4",
        note,
        format,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent":
            "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137 Mobile Safari/537.36",
        },
      }
    );

    const downloadUrl = convert.data?.downloadUrl;

    if (!downloadUrl)
      return res.json({ status: false, error: "No download link found" });

    return res.json({
      status: "success",
      downloadUrl,
    });
  } catch (err) {
    return res.json({
      status: false,
      error: err.message,
      details: err?.response?.data,
    });
  }
});

// Render uses PORT env
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Hana YT API running on port ${PORT}`)
);
