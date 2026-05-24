// ============================================================================
// Match Share Card — generates a 1200x630 social-friendly PNG from a match
// ============================================================================
//
// Renders the champion's class silhouette, team rosters, arena name, and
// duration onto an off-screen canvas. Returns a Blob so the caller can
// trigger a download or post to the Web Share API.
// ============================================================================

const W = 1200;
const H = 630;

const TEAM_COLORS = ["#00d4ff", "#ff3355"];
const TEAM_NAMES  = ["Blue Team", "Red Team"];

const BG_GRAD_STOPS = [
  [0.0, "#0a0e1a"],
  [0.5, "#0d1f2a"],
  [1.0, "#1a0d2e"],
];

/**
 * Render a card for the given match result. Returns { canvas, blob } where
 * `blob` is a PNG image/png ready to download or upload.
 */
export async function generateShareCard(result, opts = {}) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // --- Background ----------------------------------------------------------
  const bg = ctx.createLinearGradient(0, 0, W, H);
  for (const [stop, color] of BG_GRAD_STOPS) bg.addColorStop(stop, color);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Diagonal scan lines for a holographic feel.
  ctx.save();
  ctx.globalAlpha = 0.04;
  ctx.strokeStyle = "#00d4ff";
  ctx.lineWidth = 1;
  for (let y = -H; y < H * 2; y += 4) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y + 200);
    ctx.stroke();
  }
  ctx.restore();

  // Soft corner glows.
  cornerGlow(ctx, 0, 0, "rgba(0, 212, 255, 0.18)");
  cornerGlow(ctx, W, H, "rgba(170, 85, 255, 0.18)");

  // --- Header --------------------------------------------------------------
  ctx.fillStyle = "#00d4ff";
  ctx.font = "800 28px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.textAlign = "left";
  ctx.fillText("ARENA", 50, 62);
  // Measure to chain the second word at the right offset.
  const titleW = ctx.measureText("ARENA").width;
  ctx.fillStyle = "#f1f5f9";
  ctx.fillText("SCRIPT", 50 + titleW, 62);

  ctx.fillStyle = "#94a3b8";
  ctx.font = "600 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("ROBOT ARENA COMBAT", 50, 80);

  // Right-side meta chip
  const arenaName = opts.arenaName || "Arena";
  const durationLabel = opts.durationLabel || `${result.tickCount} ticks`;
  ctx.textAlign = "right";
  ctx.fillStyle = "#64748b";
  ctx.font = "500 14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(`${arenaName} · ${durationLabel}`, W - 50, 60);

  // Divider
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(50, 88);
  ctx.lineTo(W - 50, 88);
  ctx.stroke();

  // --- Outcome banner ------------------------------------------------------
  const isDraw = result.winner === null;
  const winnerTeam = isDraw ? -1 : result.winner;
  const winnerColor = isDraw ? "#94a3b8" : TEAM_COLORS[winnerTeam];

  ctx.textAlign = "center";
  ctx.fillStyle = "#94a3b8";
  ctx.font = "800 14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(isDraw ? "MATCH RESULT" : "VICTORY", W / 2, 135);

  // Glow halo behind the winning team name.
  if (!isDraw) {
    const haloGrad = ctx.createRadialGradient(W / 2, 200, 10, W / 2, 200, 380);
    haloGrad.addColorStop(0, winnerColor + "55");
    haloGrad.addColorStop(1, "transparent");
    ctx.fillStyle = haloGrad;
    ctx.fillRect(0, 90, W, 240);
  }

  ctx.fillStyle = winnerColor;
  ctx.font = "900 72px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.shadowColor = winnerColor + "88";
  ctx.shadowBlur = 24;
  const headlineText = isDraw
    ? "DRAW"
    : (opts.winnerLabel || `${TEAM_NAMES[winnerTeam].toUpperCase()} WINS`);
  ctx.fillText(headlineText, W / 2, 215);
  ctx.shadowBlur = 0;

  // Reason / subtitle
  ctx.fillStyle = "#cbd5e1";
  ctx.font = "500 18px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(opts.subtitle || prettyReason(result.reason), W / 2, 250);

  // --- Team comparison rosters --------------------------------------------
  const participants = result.replay?.metadata?.participants ?? [];
  const teamRosters = [[], []];
  for (const p of participants) {
    if (p.teamId === 0 || p.teamId === 1) teamRosters[p.teamId].push(p);
  }

  const lastFrame = result.replay?.frames?.[result.replay.frames.length - 1];
  const hpById = new Map();
  if (lastFrame) {
    for (const r of lastFrame.robots) hpById.set(r.id, { hp: r.health, alive: r.alive, robotClass: r.robotClass });
  }

  drawTeamRoster(ctx, 80, 310, 480, teamRosters[0], hpById, 0, winnerTeam === 0);
  drawTeamRoster(ctx, W - 80 - 480, 310, 480, teamRosters[1], hpById, 1, winnerTeam === 1);

  // VS divider
  ctx.textAlign = "center";
  ctx.fillStyle = "#64748b";
  ctx.font = "900 28px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("VS", W / 2, 410);

  // --- Footer --------------------------------------------------------------
  ctx.textAlign = "left";
  ctx.fillStyle = "#64748b";
  ctx.font = "500 12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(`Seed ${result.seed ?? "—"}`, 50, H - 30);

  ctx.textAlign = "right";
  ctx.fillStyle = "#94a3b8";
  ctx.font = "700 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText("Play your own match at arenascript", W - 50, H - 30);

  // --- Encode --------------------------------------------------------------
  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error("toBlob returned null")), "image/png", 0.95);
  });
  return { canvas, blob };
}

function cornerGlow(ctx, cx, cy, color) {
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 400);
  grad.addColorStop(0, color);
  grad.addColorStop(1, "transparent");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
}

function prettyReason(reason) {
  if (!reason) return "";
  return String(reason).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function drawTeamRoster(ctx, x, y, w, roster, hpById, teamId, isWinner) {
  const color = TEAM_COLORS[teamId];

  // Roster card background
  ctx.save();
  roundRect(ctx, x, y, w, 230, 12);
  ctx.fillStyle = "rgba(8, 12, 22, 0.7)";
  ctx.fill();
  ctx.strokeStyle = isWinner ? color : "rgba(255,255,255,0.06)";
  ctx.lineWidth = isWinner ? 2 : 1;
  ctx.stroke();
  ctx.restore();

  // Team name + WINNER badge
  ctx.textAlign = "left";
  ctx.fillStyle = color;
  ctx.font = "800 13px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
  ctx.fillText(TEAM_NAMES[teamId].toUpperCase(), x + 20, y + 28);
  if (isWinner) {
    ctx.textAlign = "right";
    ctx.fillStyle = color;
    ctx.font = "800 11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText("WINNER", x + w - 20, y + 28);
  }

  // Per-robot rows
  const maxRows = Math.min(roster.length, 4);
  const rowH = 38;
  const startY = y + 50;
  for (let i = 0; i < maxRows; i++) {
    const p = roster[i];
    const ry = startY + i * rowH;
    const stat = hpById.get(p.robotId) || { hp: 0, alive: false, robotClass: p.program?.robotClass };
    const alive = stat.alive && stat.hp > 0;

    // Class icon swatch
    const cls = stat.robotClass || p.program?.robotClass || "brawler";
    drawClassSwatch(ctx, x + 20, ry + 8, 20, cls, color);

    // Name (with "(you)" tag for the player)
    const nameText = p.playerId === "player" ? "Your Bot" : prettyName(p.playerId);
    ctx.textAlign = "left";
    ctx.fillStyle = alive ? "#f1f5f9" : "#64748b";
    ctx.font = "700 14px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText(nameText, x + 56, ry + 18);
    ctx.font = "500 11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillStyle = "#64748b";
    ctx.fillText(cls.toUpperCase(), x + 56, ry + 32);

    // HP bar on the right
    const barW = 130;
    const barH = 8;
    const barX = x + w - 20 - barW;
    const barY = ry + 18;
    ctx.fillStyle = "rgba(255,255,255,0.06)";
    roundRect(ctx, barX, barY, barW, barH, 4);
    ctx.fill();
    if (alive) {
      const pct = Math.max(0, Math.min(1, stat.hp / classMaxHp(cls)));
      ctx.fillStyle = pct > 0.5 ? "#22c55e" : pct > 0.25 ? "#f59e0b" : "#ef4444";
      roundRect(ctx, barX, barY, barW * pct, barH, 4);
      ctx.fill();
    }
    ctx.textAlign = "right";
    ctx.fillStyle = alive ? "#cbd5e1" : "#475569";
    ctx.font = "700 11px ui-monospace, ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(alive ? `${Math.round(stat.hp)} HP` : "DOWN", x + w - 20, ry + 36);
  }
  if (roster.length > maxRows) {
    ctx.textAlign = "left";
    ctx.fillStyle = "#64748b";
    ctx.font = "600 11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.fillText(`+${roster.length - maxRows} more`, x + 20, startY + maxRows * rowH + 18);
  }
}

function classMaxHp(cls) {
  return { brawler: 120, ranger: 80, tank: 150, support: 90 }[cls] || 100;
}

function prettyName(s) {
  if (!s) return "Robot";
  if (s === "player") return "Your Bot";
  return String(s);
}

/**
 * Mini per-class silhouette swatch — kept simple and self-contained here so
 * the share-card module doesn't depend on the live arena renderer.
 */
function drawClassSwatch(ctx, cx, cy, r, cls, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.fillStyle = color + "33";
  if (cls === "tank") {
    polygon(ctx, cx, cy, r, 8, Math.PI / 8);
  } else if (cls === "ranger") {
    ctx.beginPath();
    ctx.moveTo(cx + r,         cy);
    ctx.lineTo(cx,             cy - r * 0.7);
    ctx.lineTo(cx - r * 0.7,   cy);
    ctx.lineTo(cx,             cy + r * 0.7);
    ctx.closePath();
  } else if (cls === "support") {
    roundRect(ctx, cx - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7, 5);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillRect(cx - 2, cy - r * 0.55, 4, r * 1.1);
    ctx.fillRect(cx - r * 0.55, cy - 2, r * 1.1, 4);
    ctx.restore();
    return;
  } else {
    polygon(ctx, cx, cy, r, 6, Math.PI / 6);
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function polygon(ctx, cx, cy, r, sides, rotate) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rotate + (i / sides) * Math.PI * 2;
    const px = cx + Math.cos(a) * r;
    const py = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
}

/** Trigger a browser download of the given blob. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
