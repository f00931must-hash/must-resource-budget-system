// Budget reminder rule-time controller v1.6.4
// Each reminder rule has its own "days later + time" threshold.
// No automatic sending: records become eligible at the configured Taiwan time,
// and the manager still presses "立即提醒" manually.

import { getApps } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  setDoc,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";

const PROJECT_ID = "must-resource-budget-system";
const NOTIFY_WORKER = "https://must-resource-notify-service.f00931-must.workers.dev";
const DEFAULT_TIME = "09:00";
const $ = id => document.getElementById(id);

let auth = null;
let db = null;
let currentEmail = "";
let installed = false;
let records = [];
let settings = {};

function app() {
  return getApps().find(a => a.options?.projectId === PROJECT_ID) || null;
}

function planId() {
  return $("planSelect")?.value || "";
}

function esc(v) {
  return String(v ?? "").replace(/[&<>\"]/g, m => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[m]));
}

function validTime(v) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ""));
}

function taipeiParts(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const obj = {};
  for (const p of parts) if (p.type !== "literal") obj[p.type] = p.value;
  return obj;
}

function timestampDate(ts) {
  if (!ts) return null;
  const d = ts?.toDate?.() || new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Taiwan is UTC+8 with no DST. Build the configured calendar-day threshold precisely.
function eligibilityDate(ts, days, time) {
  const base = timestampDate(ts);
  if (!base) return new Date(0);
  const p = taipeiParts(base);
  const [hh, mm] = (validTime(time) ? time : DEFAULT_TIME).split(":").map(Number);
  const utcCalendar = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + Number(days || 0), hh - 8, mm, 0, 0));
  return utcCalendar;
}

function formatTaipei(date) {
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function approved(r) {
  return r?.reviewStatus === "approved" || r?.reviewed === true || r?.locked === true;
}

function managerWaived(r) {
  return r?.voucherWaiverManagerConfirmed === true || r?.amountConfirmedByManagerWaiver === true;
}

function hasVoucher(r) {
  return !!(r?.voucherUrl || r?.folderUrl);
}

function confirmed(r) {
  return r?.amountConfirmed === true || r?.amountManuallyConfirmed === true || managerWaived(r);
}

function formSettings() {
  return {
    enabled: $("reminderEnabled")?.checked === true,
    lineEnabled: $("reminderLineEnabled")?.checked !== false,
    lineSummaryMode: $("reminderLineSummaryMode")?.value || "names",
    messagePrefix: $("reminderMessagePrefix")?.value?.trim() || "【資源教室經費提醒】",
    missingVoucherEnabled: $("ruleMissingVoucher")?.checked !== false,
    missingVoucherAfterDays: Number($("ruleMissingVoucherDays")?.value || 0),
    missingVoucherTime: validTime($("ruleMissingVoucherTime")?.value) ? $("ruleMissingVoucherTime").value : DEFAULT_TIME,
    unconfirmedEnabled: $("ruleUnconfirmed")?.checked !== false,
    unconfirmedAfterDays: Number($("ruleUnconfirmedDays")?.value || 0),
    unconfirmedTime: validTime($("ruleUnconfirmedTime")?.value) ? $("ruleUnconfirmedTime").value : DEFAULT_TIME,
    estimatedEnabled: $("ruleEstimated")?.checked !== false,
    estimatedAfterDays: Number($("ruleEstimatedDays")?.value || 0),
    estimatedTime: validTime($("ruleEstimatedTime")?.value) ? $("ruleEstimatedTime").value : DEFAULT_TIME
  };
}

function reasonEligible(r, days, time) {
  const base = r.updatedAt || r.createdAt;
  return Date.now() >= eligibilityDate(base, days, time).getTime();
}

function classify(r, s) {
  if (approved(r)) return [];
  const out = [];

  if (
    s.estimatedEnabled !== false &&
    r.estimated === true &&
    reasonEligible(r, s.estimatedAfterDays, s.estimatedTime)
  ) out.push("預估待追蹤");

  if (r.estimated !== true) {
    if (
      s.missingVoucherEnabled !== false &&
      !hasVoucher(r) &&
      !managerWaived(r) &&
      reasonEligible(r, s.missingVoucherAfterDays, s.missingVoucherTime)
    ) out.push("缺少核銷單據");

    if (
      s.unconfirmedEnabled !== false &&
      !confirmed(r) &&
      reasonEligible(r, s.unconfirmedAfterDays, s.unconfirmedTime)
    ) out.push("未確認 Key 金額");
  }

  return out;
}

function reminderRows(s = { ...settings, ...formSettings() }) {
  return records.map(r => ({ r, reasons: classify(r, s) })).filter(x => x.reasons.length);
}

function addTimeInput(card, id, label) {
  if (!card || $(id)) return;
  const dayLabel = card.querySelector('label:not(.check-row)');
  if (!dayLabel) return;
  const timeLabel = document.createElement("label");
  timeLabel.style.marginTop = "10px";
  timeLabel.innerHTML = `${label}<input id="${id}" type="time" value="${DEFAULT_TIME}">`;
  dayLabel.insertAdjacentElement("afterend", timeLabel);
}

function installRuleTimes() {
  if (installed) return true;
  const grid = $("reminders")?.querySelector(".reminder-rule-grid");
  if (!grid) return false;
  const cards = [...grid.querySelectorAll(".reminder-rule-card")];
  if (cards.length < 3) return false;

  installed = true;
  addTimeInput(cards[0], "ruleMissingVoucherTime", "提醒時間");
  addTimeInput(cards[1], "ruleUnconfirmedTime", "提醒時間");
  addTimeInput(cards[2], "ruleEstimatedTime", "提醒時間");

  const oldWindow = $("reminderSendWindowBox");
  if (oldWindow) oldWindow.remove();

  const note = document.createElement("div");
  note.id = "ruleTimeNote";
  note.className = "muted";
  note.style.cssText = "margin-top:12px;font-size:13px";
  note.textContent = "「幾天後＋提醒時間」代表該筆資料從該時間起進入可提醒名單；系統不會自動發送，仍由管理員按「立即提醒」。";
  grid.parentElement?.appendChild(note);

  $("saveReminderSettingsBtn")?.addEventListener("click", saveTimes);
  $("refreshReminderPreviewBtn")?.addEventListener("click", () => setTimeout(refreshCustom, 80));
  $("reminderTab")?.addEventListener("click", () => setTimeout(refreshCustom, 80));
  $("planSelect")?.addEventListener("change", () => setTimeout(refreshCustom, 80));

  // Replace the base module's manual send so the configured clock times are honored.
  window.addEventListener("click", interceptSendNow, true);

  refreshCustom().catch(console.error);
  return true;
}

async function loadData() {
  const p = planId();
  if (!p || !db) {
    settings = {};
    records = [];
    return;
  }
  const [sSnap, rSnap] = await Promise.all([
    getDoc(doc(db, "reminderSettings", p)),
    getDocs(query(collection(db, "expenseRecords"), where("planId", "==", p)))
  ]);
  settings = sSnap.exists() ? sSnap.data() : {};
  records = rSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(r => r.deleted !== true);

  if ($("ruleMissingVoucherTime")) $("ruleMissingVoucherTime").value = validTime(settings.missingVoucherTime) ? settings.missingVoucherTime : DEFAULT_TIME;
  if ($("ruleUnconfirmedTime")) $("ruleUnconfirmedTime").value = validTime(settings.unconfirmedTime) ? settings.unconfirmedTime : DEFAULT_TIME;
  if ($("ruleEstimatedTime")) $("ruleEstimatedTime").value = validTime(settings.estimatedTime) ? settings.estimatedTime : DEFAULT_TIME;
}

async function saveTimes() {
  const p = planId();
  if (!p || !db) return;
  const s = formSettings();
  try {
    await setDoc(doc(db, "reminderSettings", p), {
      missingVoucherTime: s.missingVoucherTime,
      unconfirmedTime: s.unconfirmedTime,
      estimatedTime: s.estimatedTime,
      updatedAt: serverTimestamp(),
      updatedBy: currentEmail
    }, { merge: true });
  } catch (e) {
    console.error("save reminder rule times failed", e);
  }
}

function nextTimeFor(r, reason, s) {
  if (reason === "缺少核銷單據") return eligibilityDate(r.updatedAt || r.createdAt, s.missingVoucherAfterDays, s.missingVoucherTime);
  if (reason === "未確認 Key 金額") return eligibilityDate(r.updatedAt || r.createdAt, s.unconfirmedAfterDays, s.unconfirmedTime);
  return eligibilityDate(r.updatedAt || r.createdAt, s.estimatedAfterDays, s.estimatedTime);
}

function renderCustomPreview() {
  const list = $("reminderPreviewList");
  const summary = $("reminderPreviewSummary");
  if (!list || !summary) return;
  const s = { ...settings, ...formSettings() };
  const rows = reminderRows(s);
  const teachers = new Set(rows.map(x => String(x.r.ownerEmail || x.r.ownerName || "")).filter(Boolean));
  const counts = { "缺少核銷單據": 0, "未確認 Key 金額": 0, "預估待追蹤": 0 };
  rows.forEach(x => x.reasons.forEach(reason => counts[reason]++));

  summary.innerHTML = [
    ["待提醒老師", teachers.size],
    ["缺少核銷單據", counts["缺少核銷單據"]],
    ["未確認 Key 金額", counts["未確認 Key 金額"]],
    ["預估待追蹤", counts["預估待追蹤"]]
  ].map(([label, value]) => `<div class="summary-card"><span>${label}</span><strong>${value}</strong></div>`).join("");

  if (!rows.length) {
    list.innerHTML = '<div class="empty">目前沒有已到提醒日期與時間的使用紀錄。</div>';
    return;
  }

  list.innerHTML = rows.map(({ r, reasons }) => {
    const first = reasons[0];
    const at = nextTimeFor(r, first, s);
    return `<div class="reminder-preview-row">
      <div><strong>${esc(r.ownerName || r.ownerEmail || "未填老師")}</strong><small class="muted" style="display:block">${esc(r.ownerEmail || "")}</small></div>
      <div><strong>${esc(r.purpose || "未填用途")}</strong><small class="muted" style="display:block">${esc(r.semester || "未填學期")}</small></div>
      <div>${reasons.map(x => `<span class="reminder-badge">${esc(x)}</span>`).join(" ")}</div>
      <div><small class="muted">可提醒時間</small><strong style="display:block">${esc(formatTaipei(at))}</strong></div>
    </div>`;
  }).join("");
}

async function refreshCustom() {
  await loadData();
  renderCustomPreview();
}

async function notifyFetch(path, options = {}) {
  const user = auth?.currentUser;
  if (!user) throw new Error("請重新登入");
  const token = await user.getIdToken();
  const r = await fetch(NOTIFY_WORKER + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `通知服務錯誤（${r.status}）`);
  return d;
}

function buildMessage(s, rows) {
  const reasonNames = ["缺少核銷單據", "未確認 Key 金額", "預估待追蹤"];
  const reasonCount = Object.fromEntries(reasonNames.map(x => [x, 0]));
  rows.forEach(x => x.reasons.forEach(r => reasonCount[r]++));

  const lines = [
    s.messagePrefix || "【資源教室經費提醒】",
    "⚠️ 請以下老師協助確認經費資料"
  ];

  if (s.lineSummaryMode === "count") {
    lines.push(
      `缺少核銷單據：${reasonCount["缺少核銷單據"]} 筆`,
      `未確認 Key 金額：${reasonCount["未確認 Key 金額"]} 筆`,
      `預估待追蹤：${reasonCount["預估待追蹤"]} 筆`
    );
  } else {
    const map = new Map();
    for (const { r, reasons } of rows) {
      const key = String(r.ownerEmail || r.ownerName || "未填老師");
      const item = map.get(key) || {
        name: r.ownerName || r.ownerEmail || "未填老師",
        counts: { "缺少核銷單據": 0, "未確認 Key 金額": 0, "預估待追蹤": 0 }
      };
      reasons.forEach(reason => item.counts[reason]++);
      map.set(key, item);
    }
    lines.push("");
    for (const item of map.values()) {
      const details = reasonNames.filter(r => item.counts[r] > 0).map(r => `${r} ${item.counts[r]} 筆`).join("、");
      lines.push(`${item.name}｜${details}`);
    }
  }

  lines.push("", "請進入經費系統確認。");
  return lines.join("\n");
}

async function interceptSendNow(ev) {
  const target = ev.target?.closest?.("#sendLineNowBtn");
  if (!target) return;

  ev.preventDefault();
  ev.stopPropagation();
  ev.stopImmediatePropagation();

  try {
    await loadData();
    const s = { ...settings, ...formSettings() };
    if (!s.enabled) throw new Error("請先啟用此計畫的提醒系統");
    if (!s.lineEnabled) throw new Error("請先開啟 LINE 群組提醒");

    const rows = reminderRows(s);
    if (!rows.length) throw new Error("目前沒有已到提醒日期與時間的資料");

    if (!confirm(`即將傳送 LINE 提醒，共 ${rows.length} 筆待辦。\n\n確定要送出嗎？`)) return;

    target.disabled = true;
    target.textContent = "傳送中…";
    await notifyFetch("/line/send", {
      method: "POST",
      body: JSON.stringify({ text: buildMessage(s, rows) })
    });

    try {
      await addDoc(collection(db, "reminderLogs"), {
        planId: planId(),
        channel: "line",
        type: "manual-rule-time",
        count: rows.length,
        sentBy: currentEmail,
        sentAt: serverTimestamp()
      });
    } catch (e) {
      console.warn("reminder log write failed", e);
    }

    alert("LINE 提醒已傳送。");
  } catch (e) {
    console.error("rule-time reminder send failed", e);
    alert("提醒系統發生錯誤：" + (e?.message || e));
  } finally {
    target.disabled = false;
    target.textContent = "立即提醒";
  }
}

async function init() {
  for (let i = 0; i < 120; i++) {
    const a = app();
    if (a) {
      auth = getAuth(a);
      db = getFirestore(a);
      break;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  if (!auth || !db) return;

  onAuthStateChanged(auth, user => {
    currentEmail = String(user?.email || "").toLowerCase();
    if (!user) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries++;
      if (installRuleTimes() || tries > 80) clearInterval(timer);
    }, 100);
  });
}

init();
