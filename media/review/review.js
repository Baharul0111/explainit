// ExplainIT review panel (webview side). Pure renderer: the host validates every decision again.
// No external resources; runs under a strict CSP with a nonce.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  /** @type {any} */
  let view = null;
  /** Per-card UI state that must survive re-renders (draft reject reason, expanded diff). */
  const ui = { rejectOpen: {}, rejectDraft: {}, diffExpanded: {}, refused: {} };

  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v; // only host-escaped HTML (diff tables) goes through here
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children || []) if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    return el;
  }

  function send(msg) {
    vscode.postMessage(msg);
  }

  // ---------------------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------------------

  function renderIdle(waiting) {
    app.replaceChildren(
      h('p', { class: 'empty' }, [
        waiting
          ? `${waiting} change${waiting === 1 ? ' is' : 's are'} waiting. Preparing the next review…`
          : 'No change is waiting for review. When Claude Code or Codex proposes a change, it appears here one function at a time.',
      ]),
    );
  }

  function renderAll() {
    if (!view) return renderIdle(0);
    const frag = document.createDocumentFragment();
    frag.appendChild(renderHeader());
    if (view.warnings && view.warnings.length) frag.appendChild(renderBanner());
    if (view.cards.length === 0) {
      frag.appendChild(h('p', { class: 'empty' }, ['This change contains no reviewable lines.']));
    }
    view.cards.forEach((card, i) => frag.appendChild(renderCard(card, i)));
    app.replaceChildren(frag);
    const cur = document.querySelector('.card.current');
    if (cur) {
      cur.scrollIntoView({ block: 'nearest' });
      const focusTarget = cur.querySelector('textarea, button.btn.primary:not(:disabled), button.btn');
      if (focusTarget && !document.activeElement?.closest('.reject-area')) focusTarget.focus({ preventScroll: true });
    }
  }

  function renderHeader() {
    const decided = view.cards.filter((c) => c.verdict).length;
    const total = view.total;
    const pct = total ? Math.round((decided / total) * 100) : 100;
    const files = h('span', { class: 'files' }, []);
    view.paths.forEach((p, i) => {
      if (i) files.appendChild(document.createTextNode(', '));
      files.appendChild(h('button', { type: 'button', title: p.full, onclick: () => send({ type: 'openFile', path: p.full }) }, [p.short]));
    });
    return h('header', { class: 'header', role: 'banner' }, [
      h('h1', { text: `${view.agentLabel} wants to change ${view.paths.length === 1 ? 'a file' : view.paths.length + ' files'}` }),
      h('div', { class: 'meta' }, [
        h('span', {}, ['Assistant: ', h('strong', { text: view.agentLabel })]),
        h('span', {}, ['File' + (view.paths.length === 1 ? '' : 's') + ': ', files]),
        h('span', { text: total ? `Change ${Math.min(view.current + 1, total)} of ${total}` : 'No changes' }),
      ]),
      view.note ? h('div', { class: 'note', text: view.note }) : null,
      view.waiting ? h('span', { class: 'waiting', text: `${view.waiting} more change${view.waiting === 1 ? '' : 's'} waiting` }) : null,
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(decided) }, [
        h('div', { style: `width:${pct}%` }),
      ]),
    ]);
  }

  function renderBanner() {
    const cb = h('input', {
      type: 'checkbox',
      id: 'ack-warning',
      onchange: (e) => send({ type: 'ackWarning', value: !!e.target.checked }),
    });
    cb.checked = !!view.warningAcknowledged;
    return h('section', { class: 'banner', role: 'alert' }, [
      h('strong', { text: 'Take care: this change needs extra attention' }),
      h('ul', {}, view.warnings.map((w) => h('li', { text: w }))),
      h('label', { for: 'ack-warning' }, [cb, 'I understand the warning above and still want to review this change']),
    ]);
  }

  function renderCard(card, index) {
    const isCurrent = index === view.current && !card.verdict;
    const open = isCurrent;
    const badge = card.verdict
      ? h('span', { class: `badge ${card.verdict === 'accept' ? 'accepted' : 'rejected'}`, text: card.verdict === 'accept' ? 'Accepted' : 'Rejected' })
      : isCurrent
        ? h('span', { class: 'badge', text: 'Deciding now' })
        : h('span', { class: 'badge waiting', text: card.explain === 'done' ? 'Explained, waiting' : card.explain === 'error' ? 'Explanation failed' : 'Waiting' });

    const details = h('details', { class: `card${isCurrent ? ' current' : ''}`, id: `card-${card.id}`, 'data-card': card.id }, [
      h('summary', { class: 'card-head' }, [h('span', { class: 'title', text: card.title }), badge]),
      renderCardBody(card, isCurrent),
    ]);
    details.open = open;
    return details;
  }

  function renderCardBody(card, isCurrent) {
    const body = h('div', { class: 'card-body' }, []);
    if (card.verdict === 'reject' && card.rejectReason) {
      body.appendChild(h('p', { class: 'reject-reason-shown' }, ['Your reason: ', h('em', { text: card.rejectReason })]));
    }
    if (view.paths.length > 1) body.appendChild(h('p', { class: 'hint', text: `In ${card.shortPath}` }));

    if (card.trivialItems && card.trivialItems.length) {
      body.appendChild(h('h3', { text: 'What is included' }));
      body.appendChild(h('ul', { class: 'trivial-list' }, card.trivialItems.map((t) => h('li', { text: t }))));
    }

    body.appendChild(h('h3', { text: 'The change' }));
    const wrap = h('div', { class: `diff-wrap${ui.diffExpanded[card.id] ? ' expanded' : ''}`, html: card.diffHtml });
    body.appendChild(wrap);
    if (card.diffCollapsed) {
      const btn = h('button', { class: 'btn show-all', type: 'button' }, []);
      const label = () => (ui.diffExpanded[card.id] ? 'Show fewer lines' : `Show all ${card.diffRows} lines`);
      btn.textContent = label();
      btn.addEventListener('click', () => {
        ui.diffExpanded[card.id] = !ui.diffExpanded[card.id];
        wrap.classList.toggle('expanded', !!ui.diffExpanded[card.id]);
        btn.textContent = label();
      });
      body.appendChild(btn);
    }

    body.appendChild(h('h3', { text: 'What it means in plain English' }));
    body.appendChild(renderMeaning(card));

    if (isCurrent) body.appendChild(renderActions(card));
    return body;
  }

  function renderMeaning(card) {
    const el = h('div', { class: 'meaning', 'data-meaning': card.id, 'aria-live': 'polite' }, []);
    fillMeaning(el, card);
    return el;
  }

  function fillMeaning(el, card) {
    el.classList.toggle('error', card.explain === 'error');
    if (card.explain === 'done' && card.explanation) {
      const ex = card.explanation;
      el.replaceChildren(
        h('p', {}, [h('strong', { text: 'What changed: ' }), ex.whatChanged || '']),
        ex.whyItMatters && ex.whyItMatters.length ? h('p', {}, [h('strong', { text: 'Why it matters:' })]) : null,
        ex.whyItMatters && ex.whyItMatters.length ? h('ul', {}, ex.whyItMatters.map((s) => h('li', { text: s }))) : null,
        ex.risk ? h('p', { class: 'risk' }, [h('strong', { text: 'Watch out: ' }), ex.risk]) : null,
      );
    } else if (card.explain === 'error') {
      el.replaceChildren(h('p', { class: 'error-text', text: `Could not explain this change: ${card.error || 'unknown error'}` }));
    } else {
      el.replaceChildren(
        h('p', { class: 'loading', text: card.text ? 'Explaining… (streaming)' : 'Explaining…' }),
        card.text ? h('div', { class: 'streamed', text: card.text }) : null,
      );
    }
  }

  function renderActions(card) {
    const needAck = view.warnings && view.warnings.length && !view.warningAcknowledged;
    const canAccept = card.explain === 'done' && !needAck;
    const acceptTitle = card.explain !== 'done' ? 'Accept becomes available once the explanation has finished' : needAck ? 'Tick "I understand" under the warning first' : 'Accept this change (Enter)';
    const actions = h('div', { class: 'actions', 'data-actions': card.id }, []);

    if (card.explain === 'error') {
      actions.appendChild(h('button', { class: 'btn primary', type: 'button', onclick: () => send({ type: 'retry', cardId: card.id }) }, ['Retry explanation']));
    } else {
      const accept = h('button', { class: 'btn primary', type: 'button', 'data-accept': card.id, title: acceptTitle, onclick: () => send({ type: 'accept', cardId: card.id }) }, ['Accept']);
      accept.disabled = !canAccept;
      actions.appendChild(accept);
    }
    actions.appendChild(
      h('button', { class: 'btn', type: 'button', 'aria-expanded': String(!!ui.rejectOpen[card.id]), onclick: () => toggleReject(card.id, true) }, ['Reject…']),
    );
    actions.appendChild(h('span', { class: 'spacer' }));
    if (card.explain !== 'error') {
      const file = h('button', { class: 'btn', type: 'button', title: 'Accept this and every remaining change in this file', onclick: () => send({ type: 'acceptFile', cardId: card.id }) }, ['Accept rest of file']);
      file.disabled = !canAccept;
      actions.appendChild(file);
      if (view.allowSessionAccept) {
        const session = h('button', { class: 'btn', type: 'button', title: 'Accept everything else this assistant proposes in this session', onclick: () => send({ type: 'acceptSession', cardId: card.id }) }, ['Accept rest of session']);
        session.disabled = !canAccept;
        actions.appendChild(session);
      }
    }
    if (card.explain !== 'done' && card.explain !== 'error') {
      actions.appendChild(h('div', { class: 'hint', text: 'Accept unlocks when the plain-English explanation has finished.' }));
    }
    if (ui.refused[card.id]) actions.appendChild(h('div', { class: 'refused', role: 'alert', text: ui.refused[card.id] }));

    const box = h('div', { class: 'actions-box' }, [actions]);
    if (ui.rejectOpen[card.id]) box.appendChild(renderRejectArea(card));
    return box;
  }

  function renderRejectArea(card) {
    const ta = h('textarea', {
      id: `reason-${card.id}`,
      placeholder: 'For example: "Keep the old error message" or "This should not touch the database".',
      'aria-required': 'true',
      oninput: (e) => {
        ui.rejectDraft[card.id] = e.target.value;
      },
      onkeydown: (e) => {
        if (e.key === 'Escape') toggleReject(card.id, false);
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitReject(card.id);
      },
    });
    ta.value = ui.rejectDraft[card.id] || '';
    const area = h('div', { class: 'reject-area' }, [
      h('label', { for: `reason-${card.id}`, text: 'Why are you rejecting this? Your words go straight back to the assistant.' }),
      ta,
      h('div', { class: 'actions' }, [
        h('button', { class: 'btn primary', type: 'button', onclick: () => submitReject(card.id) }, ['Send rejection']),
        h('button', { class: 'btn', type: 'button', onclick: () => toggleReject(card.id, false) }, ['Cancel']),
        h('span', { class: 'hint', text: 'Ctrl/Cmd+Enter sends. Escape cancels.' }),
      ]),
    ]);
    setTimeout(() => ta.focus(), 0);
    return area;
  }

  function toggleReject(cardId, open) {
    ui.rejectOpen[cardId] = open;
    ui.refused[cardId] = '';
    renderAll();
  }

  function submitReject(cardId) {
    const reason = (ui.rejectDraft[cardId] || '').trim();
    if (!reason) {
      ui.refused[cardId] = 'Please write a reason first; it is sent to the assistant so it can revise.';
      renderAll();
      return;
    }
    send({ type: 'reject', cardId, reason: ui.rejectDraft[cardId] });
  }

  // ---------------------------------------------------------------------------------------
  // Incremental updates (streaming) — avoid re-rendering while the person is typing
  // ---------------------------------------------------------------------------------------

  function findCard(cardId) {
    return view ? view.cards.find((c) => c.id === cardId) : null;
  }

  function updateMeaning(cardId) {
    const card = findCard(cardId);
    if (!card) return;
    const el = document.querySelector(`[data-meaning="${CSS.escape(cardId)}"]`);
    if (el) fillMeaning(el, card);
    const isCurrent = view.cards.indexOf(card) === view.current && !card.verdict;
    if (isCurrent) {
      // Swap the action row so Accept/Retry reflect the new status; keep the reject draft.
      const box = document.querySelector(`[data-actions="${CSS.escape(cardId)}"]`);
      if (box && box.parentElement) box.parentElement.replaceWith(renderActions(card));
    } else {
      const head = document.querySelector(`#card-${CSS.escape(cardId)} .badge`);
      if (head && !card.verdict) head.textContent = card.explain === 'done' ? 'Explained, waiting' : card.explain === 'error' ? 'Explanation failed' : 'Waiting';
    }
  }

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    switch (msg.type) {
      case 'idle':
        view = null;
        renderIdle(msg.waiting || 0);
        break;
      case 'render':
        view = msg.view;
        renderAll();
        break;
      case 'explainStart': {
        // A (re)started explanation: drop any text streamed by the earlier attempt.
        if (!view || msg.requestId !== view.requestId) break;
        const card = findCard(msg.cardId);
        if (!card || card.explain === 'done') break;
        card.explain = 'streaming';
        card.text = '';
        card.error = undefined;
        updateMeaning(msg.cardId);
        break;
      }
      case 'explainChunk': {
        // Card ids repeat across requests; ignore anything meant for an earlier review.
        if (!view || msg.requestId !== view.requestId) break;
        const card = findCard(msg.cardId);
        if (!card || card.explain === 'done' || card.explain === 'error') break;
        card.explain = 'streaming';
        card.text = (card.text || '') + msg.chunk;
        updateMeaning(msg.cardId);
        break;
      }
      case 'explainDone': {
        if (!view || msg.requestId !== view.requestId) break;
        const card = findCard(msg.cardId);
        if (!card) break;
        card.explain = 'done';
        card.explanation = msg.explanation;
        card.error = undefined;
        updateMeaning(msg.cardId);
        break;
      }
      case 'explainError': {
        if (!view || msg.requestId !== view.requestId) break;
        const card = findCard(msg.cardId);
        if (!card || card.explain === 'done') break;
        card.explain = 'error';
        card.error = msg.reason;
        updateMeaning(msg.cardId);
        break;
      }
      case 'refused':
        ui.refused[msg.cardId] = msg.message || 'That action is not available right now.';
        renderAll();
        break;
      default:
        break;
    }
  });

  // Keyboard: Enter on the current card accepts (only when the button is enabled), R opens reject.
  document.addEventListener('keydown', (e) => {
    if (!view) return;
    const target = e.target;
    if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'BUTTON')) return;
    const cur = view.cards[view.current];
    if (!cur || cur.verdict) return;
    if (e.key === 'Enter') {
      const btn = document.querySelector(`[data-accept="${CSS.escape(cur.id)}"]`);
      if (btn && !btn.disabled) btn.click();
    } else if (e.key === 'r' || e.key === 'R') {
      toggleReject(cur.id, true);
    }
  });

  send({ type: 'ready' });
})();
