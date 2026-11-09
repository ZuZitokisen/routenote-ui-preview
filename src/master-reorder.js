/**
 * Long-press sorting for a vertical list of master rows. This module never saves
 * data itself. Drops and arrow buttons change a draft only. The parent saves
 * getOrder() with revision in one atomic transaction after explicit Save.
 *
 * Rows must be direct children of container and expose data-master-id (or use
 * getRowId). Call refresh after replacing rows, and disable/destroy on leaving
 * reorder mode. cancelGesture() restores the pre-mode order; setEnabled(false) keeps
 * the draft order (use after successful Save). refresh() cancels, never silently
 * takes a new snapshot of an active draft.
 */
export class MasterReorderConflictError extends Error {
  constructor() {
    super('一覧が変更されています。最新の並びを確認して、もう一度並び替えてください。');
    this.name = 'MasterReorderConflictError';
    this.code = 'MASTER_REORDER_CONFLICT';
  }
}

export function moveOrderedId(ids, id, targetIndex) {
  const index = ids.indexOf(id);
  if (index < 0 || !Number.isInteger(targetIndex)) throw new TypeError('Invalid reorder target.');
  const result = [...ids];
  result.splice(index, 1);
  result.splice(Math.max(0, Math.min(result.length, targetIndex)), 0, id);
  return result;
}

/** Original, untransformed row centres avoid feedback/jitter during animation. */
export function insertionIndex(rects, sourceIndex, draggedCenter, scrollShift = 0) {
  let target = sourceIndex;
  const center = rect => rect.top + rect.height / 2 + scrollShift;
  if (draggedCenter >= center(rects[sourceIndex])) {
    for (let i = sourceIndex + 1; i < rects.length; i++) {
      if (draggedCenter >= center(rects[i])) target = i;
    }
  } else {
    for (let i = sourceIndex - 1; i >= 0; i--) {
      if (draggedCenter <= center(rects[i])) target = i;
    }
  }
  return target;
}

/** Pixels per second, independent of the device's animation frame rate. */
export function edgeScrollVelocity(y, top, bottom, edge = 56, maxSpeed = 650) {
  if (!(bottom > top) || edge <= 0) return 0;
  const band = Math.min(edge, (bottom - top) / 2);
  if (y < top + band) return -maxSpeed * Math.min(1, Math.max(0, (top + band - y) / band));
  if (y > bottom - band) return maxSpeed * Math.min(1, Math.max(0, (y - bottom + band) / band));
  return 0;
}

const ATTRIBUTES = ['tabindex', 'role', 'aria-label', 'aria-keyshortcuts', 'aria-roledescription', 'aria-posinset', 'aria-setsize'];
const restoreAttribute = (node, name, value) => value === null ? node.removeAttribute(name) : node.setAttribute(name, value);
const sameOrder = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

export function installMasterReorder({
  container,
  rowSelector = '[data-master-id]',
  getRowId = row => row.dataset.masterId,
  getRowLabel = row => row.dataset.reorderLabel || row.querySelector('h2,.master-name')?.textContent?.trim() || row.textContent.trim(),
  getRevision,
  onDraftChange = () => {},
  onError = () => {},
  onStatusChange = () => {},
  longPressMs = 400,
  moveTolerance = 9,
  edgeSize = 56,
  edgeSpeed = 650,
  viewportInsets = { top: 0, bottom: 0 },
  enabled: initiallyEnabled = false,
} = {}) {
  if (!container?.ownerDocument || typeof getRevision !== 'function' || typeof onDraftChange !== 'function') {
    throw new TypeError('container and getRevision are required.');
  }
  const doc = container.ownerDocument, win = doc.defaultView;
  const snapshots = new Map(), listeners = [];
  const originalRole = container.getAttribute('role'), originalBusy = container.getAttribute('aria-busy');
  const live = doc.createElement('p');
  live.className = 'master-reorder-live';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  container.insertAdjacentElement('afterend', live);
  let enabled = false, destroyed = false, phase = 'idle', gesture = null;
  let timer = null, frame = null, renderedRevision, modeIds = [], modeNodes = [];
  let suppressClickUntil = 0;
  const now = () => win.performance.now();
  const rows = () => [...container.children].filter(row => row.matches(rowSelector));
  const announce = message => { if (!destroyed) live.textContent = message; };
  const listen = (node, type, fn, options) => {
    node.addEventListener(type, fn, options);
    listeners.push(() => node.removeEventListener(type, fn, options));
  };
  const dirty = () => enabled && !sameOrder(rows().map(getRowId), modeIds);
  const status = () => { if (!destroyed) onStatusChange({ phase, enabled, dragging: phase === 'dragging', busy: phase === 'saving', dirty: dirty() }); };
  const labelFor = row => snapshots.get(row)?.label ?? getRowLabel(row);
  const setPhase = next => {
    if (phase === next) return;
    phase = next; status();
  };
  const identify = currentRows => {
    const ids = currentRows.map(getRowId);
    if (ids.some(id => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length) {
      throw new TypeError('Reorder rows need unique, nonempty stable IDs.');
    }
    return ids;
  };
  const restoreRow = (row, snapshot) => {
    for (const name of ATTRIBUTES) restoreAttribute(row, name, snapshot.attributes[name]);
    row.classList.remove('master-reorder-row', 'master-reorder-placeholder', 'master-reorder-pressed', 'master-reorder-keyboard');
    snapshot.controls?.remove();
    row.style.transform = snapshot.transform;
    row.style.transition = snapshot.transition;
  };
  const syncRows = () => {
    const currentRows = rows();
    identify(currentRows);
    for (const [row, snapshot] of snapshots) {
      if (!currentRows.includes(row) || !enabled) {
        restoreRow(row, snapshot);
        snapshots.delete(row);
      }
    }
    if (!enabled) return;
    currentRows.forEach((row, index) => {
      if (!snapshots.has(row)) snapshots.set(row, {
        attributes: Object.fromEntries(ATTRIBUTES.map(name => [name, row.getAttribute(name)])),
        transform: row.style.transform, transition: row.style.transition, label: getRowLabel(row), controls: null,
      });
      const snapshot = snapshots.get(row);
      if (!snapshot.controls) {
        const controls = doc.createElement('span');
        controls.className = 'master-reorder-actions';
        for (const [delta, text, label] of [[-1, '↑', '上へ'], [1, '↓', '下へ']]) {
          const button = doc.createElement('button');
          button.type = 'button'; button.className = 'master-reorder-step';
          button.dataset.reorderMove = String(delta); button.textContent = text;
          button.setAttribute('aria-label', `${snapshot.label}を${label}移動`);
          controls.append(button);
        }
        row.append(controls); snapshot.controls = controls;
      }
      snapshot.controls.querySelector('[data-reorder-move="-1"]').disabled = index === 0 || phase === 'saving';
      snapshot.controls.querySelector('[data-reorder-move="1"]').disabled = index === currentRows.length - 1 || phase === 'saving';
      row.classList.add('master-reorder-row');
      row.tabIndex = 0;
      row.setAttribute('role', 'listitem');
      row.setAttribute('aria-roledescription', '並び替えできる項目');
      row.setAttribute('aria-label', `${labelFor(row)}。${index + 1} / ${currentRows.length}。長押しして移動。キーボードではスペースで持ち上げ、上下キーで移動、Enterで置く、Escapeでキャンセル。最後に保存ボタンで確定。`);
      row.setAttribute('aria-keyshortcuts', 'Space Enter ArrowUp ArrowDown Home End Escape');
      row.setAttribute('aria-posinset', String(index + 1));
      row.setAttribute('aria-setsize', String(currentRows.length));
    });
  };
  const clearTimer = () => { if (timer !== null) win.clearTimeout(timer); timer = null; };
  const clearFrame = () => { if (frame !== null) win.cancelAnimationFrame(frame); frame = null; };
  const releasePointer = previous => {
    if (previous?.kind === 'pointer' && previous.row.hasPointerCapture?.(previous.identifier)) {
      try { previous.row.releasePointerCapture(previous.identifier); } catch { /* Pointer may already have ended. */ }
    }
  };
  const resetPreview = previous => {
    previous?.ghost?.remove();
    previous?.row.classList.remove('master-reorder-pressed', 'master-reorder-placeholder', 'master-reorder-keyboard');
    if (previous?.nodes) for (const row of previous.nodes) {
      const snapshot = snapshots.get(row);
      if (snapshot) row.style.transform = snapshot.transform;
    }
    container.classList.remove('master-reorder-dragging');
    doc.documentElement.classList.remove('master-reorder-pointer-active');
  };
  const cancelGesture = (reason = 'cancel') => {
    if (!gesture) return false;
    const previous = gesture, wasDragging = phase === 'dragging';
    gesture = null;
    clearTimer(); clearFrame(); resetPreview(previous); releasePointer(previous);
    if (wasDragging) {
      suppressClickUntil = now() + 500;
      announce(reason === 'changed' ? '一覧が変更されたため、並び替えをキャンセルしました。' : '並び替えをキャンセルしました。');
    }
    setPhase('idle');
    return true;
  };
  const findRow = event => {
    const target = event.target?.nodeType === 1 ? event.target : event.target?.parentElement;
    const row = target?.closest(rowSelector);
    if (!row || row.parentElement !== container) return null;
    if (target.closest('button,a,input,textarea,select,[contenteditable="true"]')) return null;
    return row;
  };
  const isCurrent = g => container.isConnected && g.nodes.every(row => row.parentElement === container) && sameOrder(rows().map(getRowId), g.ids);
  const shifted = g => container.getBoundingClientRect().top - g.containerTop;
  const applyPreview = (g, target) => {
    g.targetIndex = target;
    const order = moveOrderedId(g.ids, g.id, target);
    let top = g.rects[0].top;
    for (let i = 0; i < order.length; i++) {
      const oldIndex = g.ids.indexOf(order[i]);
      const row = g.nodes[oldIndex], rect = g.rects[oldIndex];
      row.style.transform = `translate3d(0, ${top - rect.top}px, 0)`;
      top += rect.height + (g.gaps[i] ?? 0);
    }
    if (g.kind === 'keyboard') {
      g.row.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      announce(`${labelFor(g.row)}、${target + 1} / ${g.nodes.length}。Enterで置く、Escapeでキャンセル。最後に保存ボタンで確定。`);
    }
  };
  const updatePosition = () => {
    const g = gesture;
    if (!g || phase !== 'dragging' || g.kind === 'keyboard') return;
    if (!isCurrent(g)) { cancelGesture('changed'); return; }
    const top = g.y - g.grabOffset, shift = shifted(g);
    g.ghost.style.transform = `translate3d(0, ${top - g.rect.top}px, 0)`;
    // Keep the original gap until the dragged row has completely left it.
    if (!g.departed) g.departed = top >= g.rect.bottom + shift || top + g.rect.height <= g.rect.top + shift;
    if (g.departed) {
      const target = insertionIndex(g.rects, g.sourceIndex, top + g.rect.height / 2, shift);
      if (target !== g.targetIndex) applyPreview(g, target);
    }
  };
  const scrollParents = () => {
    const result = [];
    for (let node = container; node && node !== doc.documentElement; node = node.parentElement) {
      if (/(auto|scroll|overlay)/.test(win.getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) result.push(node);
    }
    const root = doc.scrollingElement || doc.documentElement;
    if (!result.includes(root)) result.push(root);
    return result;
  };
  const autoScroll = time => {
    frame = null;
    const g = gesture;
    if (!g || phase !== 'dragging' || g.kind === 'keyboard') return;
    if (!isCurrent(g)) { cancelGesture('changed'); return; }
    const elapsed = Math.max(1, Math.min(32, time - (g.frameTime ?? time - 16)));
    g.frameTime = time;
    const viewportTop = win.visualViewport?.offsetTop || 0;
    const viewportBottom = viewportTop + (win.visualViewport?.height || win.innerHeight);
    for (const node of g.scrollers) {
      const root = node === (doc.scrollingElement || doc.documentElement);
      const rect = root ? { top: viewportTop, bottom: viewportBottom } : node.getBoundingClientRect();
      const top = Math.max(rect.top, viewportTop + (viewportInsets.top || 0));
      const bottom = Math.min(rect.bottom, viewportBottom - (viewportInsets.bottom || 0));
      const velocity = edgeScrollVelocity(g.y, top, bottom, edgeSize, edgeSpeed);
      const maximum = Math.max(0, node.scrollHeight - (root ? win.innerHeight : node.clientHeight));
      if (!velocity || (velocity < 0 && node.scrollTop <= 0) || (velocity > 0 && node.scrollTop >= maximum)) continue;
      const before = node.scrollTop;
      node.scrollTop = Math.max(0, Math.min(maximum, before + velocity * elapsed / 1000));
      if (node.scrollTop !== before) break;
    }
    updatePosition();
    if (gesture === g) frame = win.requestAnimationFrame(autoScroll);
  };
  const createGhost = g => {
    const ghost = g.row.cloneNode(true);
    for (const node of [ghost, ...ghost.querySelectorAll('*')]) {
      for (const attr of ['id', 'name', 'for', 'data-master-id', 'data-reorder-id', 'aria-labelledby', 'aria-describedby']) node.removeAttribute(attr);
      if (node.matches('button,input,textarea,select')) node.disabled = true;
      node.removeAttribute('tabindex');
    }
    ghost.classList.remove('master-reorder-placeholder', 'master-reorder-pressed');
    ghost.classList.add('master-reorder-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.setAttribute('inert', '');
    Object.assign(ghost.style, { top: `${g.rect.top}px`, left: `${g.rect.left}px`, width: `${g.rect.width}px`, height: `${g.rect.height}px`, transform: 'translate3d(0, 0, 0)' });
    doc.body.append(ghost);
    return ghost;
  };
  const activate = () => {
    const g = gesture;
    if (!g || destroyed || !enabled || phase !== 'pending') return;
    clearTimer();
    if (!container.isConnected || g.row.parentElement !== container || getRevision() !== renderedRevision) { cancelGesture('changed'); return; }
    g.nodes = rows(); g.ids = identify(g.nodes); g.id = getRowId(g.row);
    g.sourceIndex = g.ids.indexOf(g.id); g.targetIndex = g.sourceIndex;
    g.rects = g.nodes.map(row => {
      const r = row.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, width: r.width, height: r.height };
    });
    g.rect = g.rects[g.sourceIndex];
    if (g.rect.height <= 0 || g.rect.width <= 0) { cancelGesture(); return; }
    g.gaps = g.rects.map((rect, i) => Math.max(0, (g.rects[i + 1]?.top ?? rect.bottom) - rect.bottom));
    g.expectedMasterRevision = renderedRevision;
    g.containerTop = container.getBoundingClientRect().top;
    g.grabOffset = g.kind === 'keyboard' ? g.rect.height / 2 : g.y - g.rect.top;
    g.departed = false;
    g.row.classList.remove('master-reorder-pressed');
    g.row.classList.add(g.kind === 'keyboard' ? 'master-reorder-keyboard' : 'master-reorder-placeholder');
    container.classList.add('master-reorder-dragging');
    if (g.kind !== 'keyboard') {
      g.ghost = createGhost(g);
      g.scrollers = scrollParents();
      doc.documentElement.classList.add('master-reorder-pointer-active');
      if (g.kind === 'pointer') {
        try { g.row.setPointerCapture?.(g.identifier); } catch { /* Capture is an enhancement, document listeners remain. */ }
      }
      frame = win.requestAnimationFrame(autoScroll);
    }
    g.row.focus({ preventScroll: true });
    setPhase('dragging');
    announce(`${labelFor(g.row)}を持ち上げました。上下に移動して離すと置きます。最後に保存ボタンで確定。Escapeでキャンセル。`);
  };
  const start = (row, point, kind, identifier) => {
    if (!enabled || destroyed || phase === 'saving' || rows().length < 2) return;
    if (gesture) { cancelGesture(); return; }
    gesture = { row, kind, identifier, x: point.x, y: point.y, startX: point.x, startY: point.y };
    row.classList.add('master-reorder-pressed');
    setPhase('pending');
    if (kind === 'keyboard') activate();
    else timer = win.setTimeout(activate, Math.max(0, longPressMs));
  };
  const move = (x, y) => {
    const g = gesture;
    if (!g) return;
    if (phase === 'pending' && Math.hypot(x - g.startX, y - g.startY) > moveTolerance) {
      // Before activation, let the browser own scrolling. Never steal a pan.
      cancelGesture('scroll'); return;
    }
    g.x = x; g.y = y;
    if (phase === 'dragging') updatePosition();
  };
  const placeRows = orderedRows => {
    // Preserve non-row siblings and their exact slots.
    const markers = rows().map(row => { const marker = doc.createComment('reorder'); row.replaceWith(marker); return marker; });
    markers.forEach((marker, index) => marker.replaceWith(orderedRows[index]));
  };
  const emitDraft = (orderedIds, draggedId) => {
    syncRows(); status();
    onDraftChange({ orderedIds: [...orderedIds], draggedId, expectedMasterRevision: renderedRevision });
  };
  const finish = () => {
    const g = gesture;
    if (!g) return;
    if (phase !== 'dragging') { cancelGesture(); return; }
    const orderedIds = moveOrderedId(g.ids, g.id, g.targetIndex);
    const changed = !sameOrder(orderedIds, g.ids);
    const valid = isCurrent(g) && getRevision() === g.expectedMasterRevision;
    gesture = null;
    clearTimer(); clearFrame();
    // Dropping exchanges transformed preview slots for their final DOM slots.
    // Disable transitions for this exchange, otherwise an in-flight transform
    // can be applied on top of the new layout and visibly jump twice.
    for (const row of g.nodes) row.style.transition = 'none';
    resetPreview(g); releasePointer(g);
    suppressClickUntil = now() + 500;
    setPhase('idle');
    if (!valid) {
      for (const row of g.nodes) row.style.transition = snapshots.get(row)?.transition || '';
      announce('一覧が変更されたため並び替えていません。キャンセルして最新の並びを確認してください。');
      onError(new MasterReorderConflictError()); return;
    }
    if (!changed) {
      for (const row of g.nodes) row.style.transition = snapshots.get(row)?.transition || '';
      announce('並び順は変わっていません。'); return;
    }
    placeRows(orderedIds.map(id => g.nodes[g.ids.indexOf(id)]));
    void container.offsetHeight;
    for (const row of g.nodes) row.style.transition = snapshots.get(row)?.transition || '';
    g.row.focus({ preventScroll: true });
    emitDraft(orderedIds, g.id);
    announce(`${labelFor(g.row)}を${g.targetIndex + 1}番目に移動しました。保存ボタンで確定します。`);
  };
  const moveByButton = (row, delta) => {
    if (!enabled || destroyed || phase === 'saving' || phase === 'dragging') return;
    cancelGesture();
    if (getRevision() !== renderedRevision) { onError(new MasterReorderConflictError()); return; }
    const currentRows = rows(), ids = identify(currentRows), id = getRowId(row);
    const from = ids.indexOf(id), target = from + delta;
    if (from < 0 || target < 0 || target >= ids.length) return;
    const order = moveOrderedId(ids, id, target);
    placeRows(order.map(value => currentRows[ids.indexOf(value)]));
    emitDraft(order, id); row.focus({ preventScroll: true });
    announce(`${labelFor(row)}を${target + 1}番目に移動しました。保存ボタンで確定します。`);
  };
  const cancelMode = () => {
    if (destroyed || !enabled || phase === 'saving') return false;
    cancelGesture();
    // Do not resurrect rows replaced by an external refresh/deletion.
    const current = rows();
    if (current.length === modeNodes.length && modeNodes.every(row => row.parentElement === container)) placeRows(modeNodes);
    controller.setEnabled(false);
    announce('並び替えをキャンセルし、元の並びに戻しました。');
    return true;
  };

  listen(container, 'pointerdown', event => {
    // Touch Events allow native scrolling until long-press activation. Pointer
    // Events alone cannot change touch-action after a gesture has begun.
    if (event.pointerType === 'touch' && 'TouchEvent' in win) return;
    if (event.button !== 0 || event.isPrimary === false) return;
    const row = findRow(event);
    if (row) start(row, { x: event.clientX, y: event.clientY }, 'pointer', event.pointerId);
  });
  listen(doc, 'pointermove', event => {
    if (gesture?.kind !== 'pointer' || gesture.identifier !== event.pointerId) return;
    if (phase === 'dragging') event.preventDefault();
    move(event.clientX, event.clientY);
  }, { passive: false });
  listen(doc, 'pointerup', event => {
    if (gesture?.kind !== 'pointer' || gesture.identifier !== event.pointerId) return;
    if (phase === 'dragging') event.preventDefault();
    void finish();
  });
  listen(doc, 'pointercancel', event => { if (gesture?.kind === 'pointer' && gesture.identifier === event.pointerId) cancelGesture(); });
  listen(container, 'lostpointercapture', event => { if (gesture?.kind === 'pointer' && gesture.identifier === event.pointerId) cancelGesture(); });
  listen(container, 'touchstart', event => {
    if (event.touches.length !== 1) { cancelGesture(); return; }
    const row = findRow(event), touch = event.touches[0];
    if (row) start(row, { x: touch.clientX, y: touch.clientY }, 'touch', touch.identifier);
  }, { passive: true });
  listen(doc, 'touchmove', event => {
    if (gesture?.kind !== 'touch') return;
    if (event.touches.length !== 1) { cancelGesture(); return; }
    const touch = [...event.touches].find(t => t.identifier === gesture.identifier);
    if (!touch) { cancelGesture(); return; }
    if (phase === 'dragging') {
      if (!event.cancelable) { cancelGesture('scroll'); return; }
      event.preventDefault();
    }
    move(touch.clientX, touch.clientY);
  }, { passive: false });
  listen(doc, 'touchstart', event => { if (gesture?.kind === 'touch' && event.touches.length > 1) cancelGesture(); }, { passive: true });
  listen(doc, 'touchend', event => {
    if (gesture?.kind !== 'touch' || ![...event.changedTouches].some(t => t.identifier === gesture.identifier)) return;
    if (phase === 'dragging') event.preventDefault();
    void finish();
  }, { passive: false });
  listen(doc, 'touchcancel', () => { if (gesture?.kind === 'touch') cancelGesture(); });
  listen(container, 'keydown', event => {
    if (!enabled || destroyed) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (gesture) cancelGesture(); else cancelMode(); return; }
    const row = findRow(event);
    if (!row || event.altKey || event.ctrlKey || event.metaKey) return;
    if ([' ', 'Spacebar', 'Enter'].includes(event.key)) {
      event.preventDefault();
      if (event.repeat || phase === 'saving') return;
      if (!gesture) start(row, { x: 0, y: 0 }, 'keyboard', null);
      else if (gesture.kind === 'keyboard') void finish();
    } else if (gesture?.kind === 'keyboard' && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const g = gesture;
      const target = event.key === 'Home' ? 0 : event.key === 'End' ? g.nodes.length - 1 : Math.max(0, Math.min(g.nodes.length - 1, g.targetIndex + (event.key === 'ArrowDown' ? 1 : -1)));
      applyPreview(g, target);
    } else if (event.key === 'Tab' && gesture) cancelGesture();
  });
  listen(doc, 'keydown', event => { if (event.key === 'Escape' && gesture) { event.preventDefault(); cancelGesture(); } });
  listen(container, 'click', event => {
    const button = event.target.closest?.('[data-reorder-move]');
    if (button && button.closest(rowSelector)?.parentElement === container) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (!button.disabled) moveByButton(button.closest(rowSelector), Number(button.dataset.reorderMove));
      return;
    }
    if ((enabled && phase === 'saving') || now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  listen(container, 'contextmenu', event => { if (enabled && findRow(event)) event.preventDefault(); });
  listen(container, 'dragstart', event => { if (enabled && findRow(event)) event.preventDefault(); });
  listen(doc, 'scroll', () => { if (phase === 'pending') cancelGesture('scroll'); else updatePosition(); }, true);
  for (const name of ['blur', 'resize', 'pagehide', 'hashchange', 'popstate']) listen(win, name, () => cancelGesture('navigation'));
  listen(doc, 'visibilitychange', () => { if (doc.hidden) cancelGesture('navigation'); });
  const observer = new win.MutationObserver(() => {
    if (gesture?.nodes && !isCurrent(gesture)) cancelGesture('changed');
    else if (gesture && gesture.row.parentElement !== container) cancelGesture('changed');
  });
  observer.observe(container, { childList: true });

  const controller = {
    setEnabled(value) {
      if (destroyed) return;
      const next = !!value;
      if (next === enabled) return;
      // Validate before changing controller state, so bad input cannot leave a
      // half-enabled controller or duplicate keyboard controls behind.
      const nextNodes = next ? rows() : null, nextIds = next ? identify(nextNodes) : null;
      cancelGesture(); enabled = next;
      if (phase === 'saving') phase = 'idle';
      container.classList.toggle('master-reorder-enabled', enabled);
      if (enabled) {
        container.setAttribute('role', 'list'); renderedRevision = getRevision();
        modeNodes = nextNodes; modeIds = nextIds;
      } else {
        restoreAttribute(container, 'role', originalRole);
        restoreAttribute(container, 'aria-busy', originalBusy);
      }
      syncRows();
      if (enabled) announce('長押しして上下に移動、または上下ボタンで並び替えます。最後に保存ボタンで確定してください。');
      else live.textContent = '';
      status();
    },
    getOrder() { return identify(rows()); },
    getDirty() { return dirty(); },
    setBusy(value) {
      if (destroyed || !enabled) return;
      cancelGesture();
      setPhase(value ? 'saving' : 'idle');
      if (value) container.setAttribute('aria-busy', 'true');
      else restoreAttribute(container, 'aria-busy', originalBusy);
      syncRows();
    },
    refresh() {
      if (destroyed) return;
      if (enabled) {
        if (phase === 'saving') controller.setEnabled(false);
        else cancelMode();
      }
      syncRows();
    },
    cancel: cancelMode,
    cancelDrag: cancelGesture,
    destroy() {
      if (destroyed) return;
      cancelGesture('navigation');
      if (enabled && phase !== 'saving') cancelMode();
      enabled = false;
      for (const [row, snapshot] of snapshots) restoreRow(row, snapshot);
      snapshots.clear();
      container.classList.remove('master-reorder-enabled', 'master-reorder-dragging');
      restoreAttribute(container, 'role', originalRole); restoreAttribute(container, 'aria-busy', originalBusy);
      observer.disconnect(); listeners.forEach(remove => remove()); live.remove();
      destroyed = true;
    },
    get revision() { return renderedRevision; },
    get enabled() { return enabled; },
    get dragging() { return phase === 'dragging'; },
    get busy() { return phase === 'saving'; },
    get phase() { return phase; },
  };
  if (initiallyEnabled) controller.setEnabled(true);
  return controller;
}
