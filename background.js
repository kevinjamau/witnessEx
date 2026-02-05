chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "check-name",
    title: "Find in Witness Report",
    contexts: ["selection"],
  });
});

function normalizePersian(text) {
  if (!text) return "";

  let s = String(text);

  // remove unwanted symbols
  s = s.replace(/[#_()]/g, " ");

  // remove zero-width and invisible chars (ZWNJ, ZWJ, BOM, etc.)
  s = s.replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g, " ");

  // Arabic to Persian letter normalization
  s = s
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/إ|أ|ٱ/g, "ا")
    .replace(/،/g, "")
    .replace(/,/g, "");

  // Remove diacritics and tatweel
  s = s.replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "");

  // Convert Arabic-Indic digits to Persian
  s = s.replace(/[٠-٩]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"["٠١٢٣٤٥٦٧٨٩".indexOf(d)]);

  // Convert Latin digits to Persian
  s = s.replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[d.charCodeAt(0) - 48]);

  // Normalize whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getApiKeyFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["apikey"], (result) => {
      resolve((result && result.apikey) ? String(result.apikey) : "");
    });
  });
}

function setApiKeyToStorage(key) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ apikey: key }, () => resolve());
  });
}

// Prompt MUST be run in the page context (not in the service worker)
async function promptForApiKey(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const v = window.prompt("Enter API key for Witness Report:");
      return v ? String(v).trim() : "";
    },
  });

  // executeScript returns [{ result: ... }]
  return (results && results[0] && results[0].result) ? results[0].result : "";
}

async function showAlert(tabId, msg) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (m) => alert(m),
    args: [msg],
  });
}

async function showPopup(tabId, pageHtml) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (html) => {
      const w = window.open("", "_blank", "width=520,height=640");
      if (!w) {
        alert("Popup blocked. Allow popups for this site.");
        return;
      }
      w.document.open();
      w.document.write(html);
      w.document.close();

      // Auto-close after 2 minutes (120000 milliseconds)
      setTimeout(() => {
        w.close();
      }, 120000);
    },
    args: [pageHtml],
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "check-name") return;

  const tabId = tab && tab.id;
  if (!tabId) return;

  const name = normalizePersian((info.selectionText || "").trim());
  if (!name) return;

  try {
    // Get API key, ask on first run if empty
    let apiKey = await getApiKeyFromStorage();
    if (!apiKey) {
      apiKey = await promptForApiKey(tabId);
      if (!apiKey) {
        await showAlert(tabId, "API key is required.");
        return;
      }
      await setApiKeyToStorage(apiKey);
    }

    const form = new FormData();
    form.append("name", name);
    form.append("apikey", apiKey);

    const res = await fetch("https://witness.report/api/api.php", {
      method: "POST",
      body: form,
    });

    const raw = await res.text();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Response not JSON. HTTP ${res.status}\n${raw.slice(0, 500)}`);
    }

    // Check for invalid API key BEFORE checking res.ok
    if (parsed && parsed.error) {
      const err = String(parsed.error);
      if (err.toLowerCase().includes("invalid api key")) {
        await setApiKeyToStorage("");
        await showAlert(tabId, "Invalid API key. Please enter a new one.");
        
        // Prompt for new API key
        const newApiKey = await promptForApiKey(tabId);
        if (!newApiKey) {
          await showAlert(tabId, "API key is required.");
          return;
        }
        await setApiKeyToStorage(newApiKey);
        
        // Retry the request with new API key
        const retryForm = new FormData();
        retryForm.append("name", name);
        retryForm.append("apikey", newApiKey);
        
        const retryRes = await fetch("https://witness.report/api/api.php", {
          method: "POST",
          body: retryForm,
        });
        
        const retryRaw = await retryRes.text();
        try {
          parsed = JSON.parse(retryRaw);
        } catch {
          throw new Error(`Response not JSON. HTTP ${retryRes.status}\n${retryRaw.slice(0, 500)}`);
        }
        
        // Check for invalid key again in retry response
        if (parsed && parsed.error && String(parsed.error).toLowerCase().includes("invalid api key")) {
          await setApiKeyToStorage("");
          throw new Error(`Server error: Invalid API key`);
        }
        
        if (!retryRes.ok && (!parsed || !parsed.error)) {
          throw new Error(`HTTP ${retryRes.status}\n${retryRaw.slice(0, 500)}`);
        }
        
        if (parsed && parsed.error) {
          throw new Error(`Server error: ${String(parsed.error)}`);
        }
      } else {
        throw new Error(`Server error: ${err}`);
      }
    }

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}\n${raw.slice(0, 500)}`);
    }

    const existVal = parsed.exist ?? parsed.exists;
    const exists =
      existVal === "1" ||
      existVal === 1 ||
      existVal === true ||
      String(existVal).toLowerCase() === "true";

    // Build popup HTML with clickable links
    let html = `
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Witness Report Search</title>
        </head>
        <body style="font-family:sans-serif; padding:14px; line-height:1.45;">
          <h2 style="margin:0 0 10px 0;">Witness Report Search</h2>
    `;

    if (exists && parsed.matches && parsed.matches.length > 0) {
      const count = parsed.count || parsed.matches.length;

      html += `
        <div style="margin-bottom:10px;">
          <div style="font-size:16px; font-weight:700;">
            ✅ FOUND ${count} MATCH${count > 1 ? "ES" : ""}
          </div>
          <div style="margin-top:6px; color:#444;">
            Search: <b>${escapeHtml(name)}</b>
          </div>
        </div>
        <hr />
      `;

      parsed.matches.forEach((match, index) => {
        const fullName = escapeHtml(match.fullName);
        const isDeleted = escapeHtml(match.isDeleted);
        const updated = escapeHtml(match.updated);
        const city = escapeHtml(match.city ?? "");
        const link = String(match.link ?? "").trim();
        const thumbnail = String(match.thumbnail ?? "").trim();
        const detentionStatus = escapeHtml(match.detentionStatus ?? "");
        const age = escapeHtml(match.age ?? "");

        html += `
          <div style="margin:10px 0; display:flex; gap:12px;">
        `;

        if (thumbnail) {
          html += `
            <div style="flex-shrink:0;">
              <img src="${escapeHtml(thumbnail)}" alt="Photo" style="width:80px; height:80px; object-fit:cover; border-radius:4px; border:1px solid #ddd;" />
            </div>
          `;
        }

        html += `
            <div style="flex:1;">
              <div style="font-weight:700;">${index + 1}. ${fullName}</div>
              <div style="color:${isDeleted === '1' ? 'red' : 'green'}; font-weight:600;">
          ${isDeleted === '1' ? 'Deleted' : 'Active'} ${detentionStatus ? `[${detentionStatus}]` : ''}
              </div>
              <div>Updated: ${updated}</div>
              ${city ? `<div>City: ${city}</div>` : ''}
              ${age && age !== '0' ? `<div>Age: ${age}</div>` : ''}
              
        `;
        if (link) {
          const linkForCopy = link.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
          html += `<div>
            <a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">link</a>
          </div>`;
        }

        html += `
            </div>
          </div>
          <hr />
        `;
      });
    } else {
      const nameForCopy = name.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
      const googleSearchUrl = `https://www.google.com/search?q=${encodeURIComponent(name)}`;
      html += `
        <div style="font-size:16px; font-weight:700;">❌ NOT FOUND</div>
        <div style="margin-top:6px;">Name: <b>${escapeHtml(name)}</b></div>
        <div style="margin-top:12px;">
          <a href="${escapeHtml(googleSearchUrl)}" target="_blank" rel="noopener noreferrer" style="padding:8px 16px; border:1px solid #4285f4; border-radius:4px; background:#4285f4; color:white; text-decoration:none; display:inline-block; font-size:14px;">🔍 Search on Google</a>
        </div>
      `;
    }

    html += `

        </body>
      </html>
    `;

    await showPopup(tabId, html);
  } catch (e) {
    await showAlert(tabId, `Error checking name:\n${String(e.message || e)}`);
  }
});
