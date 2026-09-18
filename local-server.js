// local-server.js
//
// A free helper program that runs on YOUR computer only — no signup,
// no API key, no cost. It does two jobs:
//   1. Shows your website (index.html, styles.css, app.js) in the browser.
//   2. When the website asks for a Reel, it asks yt-dlp to go fetch the
//      real video link, and later streams the actual video file back.
//
// You need:
//   - Node.js installed (18 or newer)
//   - The yt-dlp program sitting in this same folder
//     (yt-dlp.exe on Windows, or "yt-dlp" on Mac/Linux)
//
// To run it: open a terminal in this folder and type:
//   node local-server.js
// Then open http://localhost:8787 in your browser.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const PORT = process.env.PORT || 8787;
const ROOT = __dirname;
const YTDLP = process.platform === "win32" ? "yt-dlp.exe" : "./yt-dlp";

const MIME = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".woff2": "font/woff2",
  ".jpg": "image/jpeg",
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === "/api/resolve") return handleResolve(url, res);
  if (url.pathname === "/api/download") return handleDownload(url, res);
  return serveStatic(url.pathname, res);
});

// -------- Step 1: ask yt-dlp for the real video link --------
function handleResolve(url, res) {
  const reelUrl = url.searchParams.get("url");
  if (!reelUrl) return sendJson(res, 400, { message: "Missing url" });

  execFile(
    YTDLP,
    [
      "-j",
      "--no-warnings",
      // Without this, yt-dlp's default picks the best *video-only*
      // stream when a site (like Instagram) also offers a separate
      // audio-only one — meant to be merged by a downloader, which we
      // aren't doing. That produced a "video" with no sound on PC, and
      // on iPhone, a broken-looking file with no thumbnail (since it's
      // not a normal, complete video file). "best" forces a single
      // format that already has both audio and video combined.
      "-f",
      "best",
      reelUrl,
    ],
    { maxBuffer: 1024 * 1024 * 20 },
    (err, stdout) => {
      if (err) {
        console.error(err.message);
        return sendJson(res, 502, {
          message: "yt-dlp couldn't fetch that link. Is it a public Reel? Try updating yt-dlp (yt-dlp -U).",
        });
      }
      try {
        const data = JSON.parse(stdout);
        // Prints straight to Render's Logs tab (or your terminal locally).
        // This is how we can tell FOR SURE whether the chosen format
        // actually has audio, instead of guessing from symptoms alone.
        console.log(
          `Resolved format: vcodec=${data.vcodec} acodec=${data.acodec} format_id=${data.format_id}`
        );
        sendJson(res, 200, {
          videoUrl: data.url,
          thumbnail: data.thumbnail || "",
          caption: data.description || data.title || "",
          filename: "reel.mp4",
        });
      } catch {
        sendJson(res, 502, { message: "Couldn't read yt-dlp's response." });
      }
    }
  );
}

// -------- Step 2: hand the actual video bytes to the browser --------
async function handleDownload(url, res) {
  const src = url.searchParams.get("src");
  const name = url.searchParams.get("name") || "reel.mp4";
  if (!src) return sendJson(res, 400, { message: "Missing src" });

  try {
    // Instagram/Facebook's CDN often 403s a request that doesn't look
    // like it came from a browser (no Referer/User-Agent) — that error
    // page is tiny, and without the checks below it would get saved as
    // if it were the actual video.
    const upstream = await fetch(src, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        referer: "https://www.instagram.com/",
      },
    });

    if (!upstream.ok || !upstream.body) {
      console.error(`Upstream video fetch failed: ${upstream.status} ${upstream.statusText}`);
      return sendJson(res, 502, {
        message: `Couldn't fetch the video from Instagram's server (status ${upstream.status}). The link may have expired — try fetching the Reel again.`,
      });
    }

    res.writeHead(200, {
      "content-type": upstream.headers.get("content-type") || "video/mp4",
      "content-disposition": buildContentDisposition(name),
    });
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (e) {
    console.error(e.message);
    sendJson(res, 502, { message: "Download failed." });
  }
}

// -------- Just serves your HTML/CSS/JS files as normal --------
function serveStatic(pathname, res) {
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(ROOT, pathname);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// HTTP headers only allow plain ASCII (technically Latin-1) bytes — a
// caption-based filename can contain emoji or other Unicode, which would
// make res.writeHead() throw ("Invalid character in header content").
// This keeps a safe plain-ASCII fallback in the regular filename="..."
// part, and puts the real Unicode name in the standard filename*=UTF-8''
// form (RFC 5987/6266) that browsers already know how to read. Either
// way, the file the browser actually saves is controlled by the
// download attribute set in app.js, not by this header.
function buildContentDisposition(name) {
  const safeName = (name || "reel.mp4").replace(/["\\]/g, "");
  const asciiFallback = safeName.replace(/[^\x20-\x7E]/g, "_").trim() || "reel.mp4";
  const encoded = encodeURIComponent(safeName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

server.listen(PORT, () => {
  console.log(`ReelDock test server running — open http://localhost:${PORT}`);
});
