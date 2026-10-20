(() => {
  if (window.top !== window || !/^\/server\/[1-9]\d*\/votes\/?$/.test(location.pathname)) return;
  let tour = null, busy = false, stopped = false, scrolled = false, interval;
  let host, label, hint, skip, stop, progress;
  const visible = node => node?.getClientRects().length > 0
    && getComputedStyle(node).visibility !== "hidden" && getComputedStyle(node).display !== "none";
  function voteCard() {
    const heading = [...document.querySelectorAll(".card-header .head")]
      .find(node => node.textContent.trim() === "Голосование");
    return heading?.closest(".card");
  }
  function inspect() {
    const card = voteCard();
    if (!card || !visible(card)) return { status: "unknown" };
    if (!scrolled) {
      card.scrollIntoView({ block: "center", behavior: "instant" });
      scrolled = true;
    }
    const footer = card.querySelector(".card-footer");
    if (!footer) return { status: "unknown" };
    const controls = [...footer.querySelectorAll(".btn, button")].filter(visible);
    const timer = controls.map(node => node.textContent.trim())
      .find(text => /^(?:\d{1,2}\s*ч(?:ас(?:а|ов)?)?\.?\s*)?\d{1,2}\s*м(?:ин(?:ут(?:а|ы)?)?)?\.?$/i.test(text.replace(/\u00a0/g, " ")));
    if (timer) return { status: "cooldown", timer };
    const button = footer.querySelector('[data-send="/server/vote"], .voting');
    if (button && visible(button)) {
      return { status: !button.matches(":disabled, [disabled], .disabled")
        && button.getAttribute("data-send") === "/server/vote"
        && /^голосовать$/i.test(button.textContent.trim()) ? "ready" : "activation" };
    }
    if (footer.querySelector('[data-send="/auth"], a[href="/auth"]')) return { status: "login" };
    return { status: "unknown" };
  }
  function makePanel() {
    host = document.createElement("div");
    host.id = "twinkle-vote-guide";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ":host{all:initial;position:fixed;bottom:16px;right:16px;z-index:2147483646;width:min(350px,calc(100vw - 32px));font:13px/1.5 Segoe UI,system-ui,sans-serif;color:#e9edef}section{background:#202529;border:1px solid #49535b;border-radius:8px;padding:16px;box-shadow:0 6px 24px #0004}header{display:flex;align-items:center;gap:9px;color:#c1cbd2;font-size:12px}header b{display:grid;place-items:center;width:24px;height:24px;background:#343c42;color:#eef0f1;border-radius:4px;font-size:16px}strong{margin-left:auto;font-size:11px;font-weight:500;font-variant-numeric:tabular-nums;color:#9cabb5}p{margin:12px 0 14px;color:#c0cbd3;font-size:12px}.track{height:3px;background:#374148;margin:12px 0 14px;overflow:hidden;border-radius:2px}.progress{height:100%;background:#a8c6d8;width:0}button{font:12px Segoe UI,system-ui,sans-serif;border:1px solid #4b5861;border-radius:5px;background:#303a41;color:#dfe6ea;padding:7px 12px;cursor:pointer;margin-right:8px}button:last-child{background:transparent;color:#9fadb6;border-color:transparent}button:focus-visible{outline:2px solid #a8c6d8}button:disabled{opacity:.5}";
    const box = document.createElement("section");
    label = document.createElement("strong");
    hint = document.createElement("p");
    hint.setAttribute("role", "status");
    skip = document.createElement("button");
    stop = document.createElement("button");
    skip.textContent = "Пропустить";
    stop.textContent = "Остановить";
    skip.onclick = event => { if (event.isTrusted) control("tour:skip"); };
    stop.onclick = event => { if (event.isTrusted) control("tour:pageStop"); };
    const header = document.createElement("header");
    const monogram = document.createElement("b");
    monogram.textContent = "Т";
    monogram.setAttribute("aria-hidden", "true");
    const brand = document.createElement("span");
    brand.textContent = "Твинкл";
    header.append(monogram, brand, label);
    const track = document.createElement("div");
    track.className = "track";
    progress = document.createElement("div");
    progress.className = "progress";
    track.append(progress);
    box.append(header, hint, track, skip, stop);
    shadow.append(style, box);
    document.documentElement.append(host);
  }
  function show(view) {
    if (!host) makePanel();
    label.textContent = `${Math.min(view.index + 1, view.total)} / ${view.total}`;
    progress.style.width = `${Math.min(100, view.index / view.total * 100)}%`;
    hint.textContent = view.message;
    skip.disabled = stop.disabled = !view.active;
  }
  async function send(type, extra = {}) {
    return chrome.runtime.sendMessage({ type, tourId: tour?.id, ...extra });
  }
  async function control(type) {
    if (busy || stopped) return;
    busy = true;
    try {
      const reply = await send(type);
      if (!reply?.ok) throw new Error();
      if (reply.tour) show(reply.tour);
      stopped = true;
      clearInterval(interval);
    } catch {
      hint.textContent = "Не получилось выполнить действие. Откройте Твинкл через его значок.";
    } finally { busy = false; }
  }
  async function tick() {
    if (busy || stopped) return;
    busy = true;
    try {
      const reply = await send("tour:observe", inspect());
      if (!reply?.ok) throw new Error();
      if (!reply.tour || !reply.tour.active || reply.tour.id !== tour.id) {
        stopped = true;
        clearInterval(interval);
        if (reply.tour) show(reply.tour);
        else { hint.textContent = "Проход остановлен. Откройте Твинкл, чтобы продолжить."; skip.disabled = stop.disabled = true; }
        return;
      }
      tour = reply.tour;
      show(tour);
    } catch {
      hint.textContent = "Связь с Твинкл прервалась. Откройте расширение и нажмите «Продолжить».";
      stopped = true;
      clearInterval(interval);
    } finally { busy = false; }
  }
  document.addEventListener("click", event => {
    if (!event.isTrusted || stopped || !tour) return;
    const card = voteCard();
    const button = event.target instanceof Element ? event.target.closest('[data-send="/server/vote"]') : null;
    if (!button || !card?.contains(button) || !visible(button)
        || button.matches(":disabled, [disabled], .disabled") || inspect().status !== "ready") return;
    send("tour:clicked").then(reply => { if (reply?.tour) show(reply.tour); }).catch(() => {});
  }, true);
  chrome.runtime.sendMessage({ type: "tour:hello" }).then(reply => {
    if (!reply?.ok || !reply.tour?.active) return;
    tour = reply.tour;
    show(tour);
    tick();
    interval = setInterval(tick, 700);
  }).catch(() => {});
})();
