// ---------------------------------------------------------------
// ReelDock client logic
//
// TEST_MODE lets you build and test the whole flow — resolve,
// fake ad, countdown, download — before you've hooked up a real
// resolver API or a real ad network. Flip it to false once your
// backend endpoints (see /functions/api/*) are live.
// ---------------------------------------------------------------
const TEST_MODE = false;

const TEST_RESULT = {
  thumbnail: "https://placehold.co/200x200/0f6b5c/ffffff?text=Reel",
  caption: "Sample caption — this is fake data shown because TEST_MODE is on.",
  // A small public-domain sample clip, just so the download step has
  // something real to save while you're testing.
  videoUrl: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
  filename: "reeldock-test.mp4",
};

const AD_SECONDS = 10;
const MAX_TAGS = 7;

const form = document.getElementById("resolve-form");
const urlInput = document.getElementById("reel-url");
const resolveBtn = document.getElementById("resolve-btn");
const errorEl = document.getElementById("form-error");

const resultCard = document.getElementById("result");
const resultThumb = document.getElementById("result-thumb");
const resultCaption = document.getElementById("result-caption");
const resultTags = document.getElementById("result-tags");
const downloadBtn = document.getElementById("download-btn");

const adModal = document.getElementById("ad-modal");
const adProgressFill = document.getElementById("ad-progress-fill");
const adCountdownWrap = document.getElementById("ad-countdown-wrap");
const adCountdownNum = document.getElementById("ad-countdown-num");
const adStatus = document.getElementById("ad-status");
const adCancelBtn = document.getElementById("ad-cancel-btn");
const adReadyBtn = document.getElementById("ad-ready-btn");

let currentResult = null;
let countdownTimer = null;
let downloadAbortController = null;
let preparedDownload = null; // { objectUrl, filename } once the video is ready to save
let prepareError = null;
let preparePromise = null;

// ---------------- Step 1: resolve the link into a video ----------------

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideError();
  resultCard.hidden = true;

  const url = urlInput.value.trim();
  if (!isLikelyReelUrl(url)) {
    showError("That doesn't look like an Instagram Reel link.");
    return;
  }

  setResolving(true);
  try {
    currentResult = TEST_MODE ? await fakeResolve() : await resolveReel(url);
    showResult(currentResult);
  } catch (err) {
    showError(err.message || "Couldn't fetch that Reel. Double-check the link and try again.");
  } finally {
    setResolving(false);
  }
});

function isLikelyReelUrl(url) {
  return /instagram\.com\/(reel|p|reels)\//i.test(url);
}

async function fakeResolve() {
  await new Promise((r) => setTimeout(r, 500)); // pretend it took a moment
  return TEST_RESULT;
}

async function resolveReel(url) {
  const res = await fetch(`/api/resolve?url=${encodeURIComponent(url)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || "Couldn't resolve that link.");
  }
  const data = await res.json();
  // The download step needs the original Instagram link (not just the
  // raw video URL) so the server can re-run yt-dlp against it to merge
  // separate audio+video streams when Instagram doesn't provide one
  // single combined file.
  data.reelUrl = url;
  return data;
}

function showResult(data) {
  resultThumb.src = data.thumbnail || "";

  const { mainCaption, tags } = splitCaptionAndTags(data.caption);
  // Stash the cleaned values back onto the result so the download step
  // (and the filename it builds) can reuse them without re-parsing.
  data.mainCaption = mainCaption;
  data.tags = tags;

  resultCaption.textContent = mainCaption;

  if (tags.length) {
    resultTags.textContent = tags.join(" ");
    resultTags.hidden = false;
  } else {
    resultTags.textContent = "";
    resultTags.hidden = true;
  }

  resultCard.hidden = false;
}

// Auto-detects hashtags anywhere in the caption (Instagram captions often
// end with a run of tags), pulls them out onto their own line, and caps
// how many are shown so a tag-spam caption doesn't push the real caption
// out of view.
function splitCaptionAndTags(rawCaption) {
  const text = rawCaption || "";
  const tagPattern = /#[\p{L}\p{N}_]+/gu;
  const allTags = text.match(tagPattern) || [];

  const mainCaption = text
    .replace(tagPattern, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const tags = allTags.slice(0, MAX_TAGS);

  return { mainCaption, tags };
}

function setResolving(isResolving) {
  resolveBtn.disabled = isResolving;
  resolveBtn.textContent = isResolving ? "Fetching…" : "Get video";
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}
function hideError() {
  errorEl.hidden = true;
}

// ---------------- Step 2: ad gate, then the real download ----------------

downloadBtn.addEventListener("click", () => {
  if (!currentResult) return;
  openAdGate();
});

adCancelBtn.addEventListener("click", closeAdGate);

// This is the one click that actually saves the file. By this point the
// video was already fetched in the background while the ad played, so
// this handler does nothing but a synchronous a.click() — no awaits in
// between. That matters on phones: mobile Safari/Chrome will silently
// block a file save that isn't triggered directly inside a real tap,
// which is exactly why the old "auto-download once the countdown hits
// 0" approach worked on desktop but quietly did nothing on mobile.
adReadyBtn.addEventListener("click", () => {
  if (!preparedDownload) return;
  const { objectUrl, filename } = preparedDownload;
  preparedDownload = null; // hand off so closeAdGate() below won't revoke it

  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);

  closeAdGate();
});

function openAdGate() {
  adModal.hidden = false;
  adModal.setAttribute("aria-hidden", "false");
  adProgressFill.style.transition = "none";
  adProgressFill.style.width = "0%";
  adCountdownNum.textContent = String(AD_SECONDS);
  adCountdownWrap.hidden = false;
  adStatus.hidden = true;
  adReadyBtn.hidden = true;

  preparedDownload = null;
  prepareError = null;
  downloadAbortController = new AbortController();
  // Start fetching the actual video right away, in parallel with the ad
  // countdown, so it's already sitting in memory the moment the ad ends.
  preparePromise = prepareDownload(currentResult, downloadAbortController.signal)
    .then((result) => { preparedDownload = result; })
    .catch((err) => {
      if (err.name === "AbortError") return;
      prepareError = err.message || "The download didn't start. Please try again.";
    });

  // Drive the bar's width by hand from actual elapsed time, in lockstep
  // with the countdown number, instead of a CSS transition. A CSS
  // transition is a separate clock the browser controls — and on some
  // PCs, an OS "reduce motion" / "show animations off" setting silently
  // disables it entirely (see the prefers-reduced-motion rule in
  // styles.css), which made the bar jump straight to 100% instantly
  // while the number kept counting down normally on its own. Setting
  // the width directly every tick can't be skipped that way, and can
  // never drift out of sync with the number since they're computed
  // from the exact same clock.
  const startTime = Date.now();
  const totalMs = AD_SECONDS * 1000;

  countdownTimer = setInterval(async () => {
    const elapsedMs = Date.now() - startTime;
    const remaining = Math.max(0, Math.ceil((totalMs - elapsedMs) / 1000));
    const progressPct = Math.min(100, (elapsedMs / totalMs) * 100);

    adCountdownNum.textContent = String(remaining);
    adProgressFill.style.width = `${progressPct}%`;

    if (elapsedMs >= totalMs) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      adProgressFill.style.width = "100%";
      await revealDownloadOrError();
    }
  }, 100);
}

async function revealDownloadOrError() {
  adCountdownWrap.hidden = true;
  adStatus.hidden = false;
  adStatus.textContent = "Preparing your download…";

  await preparePromise; // usually already settled by the time the ad ends

  if (prepareError) {
    adCountdownWrap.hidden = true;
    adReadyBtn.hidden = true;
    adStatus.hidden = false;
    adStatus.textContent = prepareError;
    adStatus.classList.add("text-pink-600", "font-semibold");
    showError(prepareError);
    return;
  }

  adStatus.classList.remove("text-pink-600", "font-semibold");
  adStatus.textContent = "Your video is ready — press the button below to download.";
  adReadyBtn.hidden = false;
}

function closeAdGate() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  if (downloadAbortController) {
    downloadAbortController.abort();
    downloadAbortController = null;
  }
  if (preparedDownload) {
    URL.revokeObjectURL(preparedDownload.objectUrl);
    preparedDownload = null;
  }
  prepareError = null;

  adModal.hidden = true;
  adModal.setAttribute("aria-hidden", "true");
  adProgressFill.style.transition = "none";
  adProgressFill.style.width = "0%";
  adCountdownWrap.hidden = false;
  adStatus.hidden = true;
  adStatus.classList.remove("text-pink-600", "font-semibold");
  adReadyBtn.hidden = true;
}

async function prepareDownload(data, signal) {
  const filename = buildFilenameFromCaption(data);

  // In test mode (or for same-origin CORS-friendly URLs) a direct blob
  // fetch works. In production, route this through your own backend
  // (/api/download) instead — Instagram's CDN generally won't allow a
  // browser to fetch its video bytes directly (no CORS headers), and
  // proxying also lets you force a clean filename and "Save As" behavior.
  let src;
  if (TEST_MODE) {
    src = data.videoUrl;
  } else {
    // encodeURIComponent() throws on a malformed string (a stray
    // surrogate that slipped past buildFilenameFromCaption some other
    // way). If that ever happens, fall back to a safe generic name
    // rather than surfacing a raw browser error to the user.
    let safeName;
    try {
      safeName = encodeURIComponent(filename);
    } catch {
      safeName = encodeURIComponent("reel.mp4");
    }
    src = `/api/download?src=${encodeURIComponent(data.reelUrl)}&name=${safeName}`;
  }

  const res = await fetch(src, { signal });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || "The download didn't start. Please try again.");
  }
  const blob = await res.blob();
  if (blob.size < 1024) {
    // A real Reel is at minimum tens of KB. Anything this small is an
    // error page or an empty response that slipped through, not a video.
    throw new Error("The downloaded file looks broken (too small). Please try again.");
  }
  const objectUrl = URL.createObjectURL(blob);
  return { objectUrl, filename };
}

// Saves the file under the reel's main caption (tags already stripped in
// splitCaptionAndTags), not the generic "reel.mp4" the resolver returns
// and not the hashtags. Falls back to "reel" if the caption is empty or
// turns out to be nothing but tags/whitespace once cleaned.
function buildFilenameFromCaption(data) {
  const source = data.mainCaption || splitCaptionAndTags(data.caption).mainCaption;

  let name = (source || "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Strip characters that are illegal (or awkward) in file names on
    // Windows/macOS/Linux.
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .trim();

  const MAX_NAME_LENGTH = 80;
  if (name.length > MAX_NAME_LENGTH) {
    // JS strings are UTF-16, and many emoji are two code units long (a
    // "surrogate pair"). A plain name.slice(0, N) can land in the middle
    // of one of those pairs, leaving a single dangling half-character —
    // which later crashes encodeURIComponent() with "URI malformed" on
    // Chrome, or "the string contained an illegal UTF-16 sequence" on
    // Safari. Array.from() splits by whole character instead, so this
    // can never cut a pair in half.
    name = Array.from(name).slice(0, MAX_NAME_LENGTH).join("").trim();
  }

  // Belt-and-suspenders: also strip any lone/unpaired surrogate that
  // might have made it in some other way (some captions contain unusual
  // emoji sequences), so this is safe no matter how "name" was built.
  // Belt-and-suspenders: also strip any lone/unpaired surrogate that
  // might have made it in some other way (some captions contain unusual
  // emoji sequences), so this is safe no matter how "name" was built.
  name = stripLoneSurrogates(name);

  if (!name) name = "reel";
  return `${name}.mp4`;
}

// Removes any UTF-16 surrogate code unit that isn't part of a valid
// pair. Plain string indexing/slicing can produce these, and a lone
// surrogate crashes encodeURIComponent() ("URI malformed" on Chrome,
// "illegal UTF-16 sequence" on Safari) — so anywhere a filename gets
// built from arbitrary caption text funnels through here first.
function stripLoneSurrogates(str) {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += str[i] + str[i + 1];
        i++; // consumed the matching low surrogate too
      }
      // else: lone high surrogate — drop it
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // lone low surrogate (no preceding high surrogate claimed it) — drop it
    } else {
      out += str[i];
    }
  }
  return out;
}

document.getElementById("year").textContent = new Date().getFullYear();
