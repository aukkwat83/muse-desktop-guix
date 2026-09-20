// Sidebar: group blocks with nested chats, modelled on grok-desktop's.
//
// Layout of one row:
//   ⋮⋮ drag handle · ▸/▾ expand · name (dbl-click renames) · ＋ · − · count · ⋯
// and, when expanded, a dashed "＋ session" tab above the chats in that group.
//
// Two structural rules worth keeping:
//   - only the ⋮⋮ handle drags a group; chat rows drag independently, so
//     picking up a chat can never accidentally reorder its group
//   - the group owning the active chat is always expanded and cannot be
//     collapsed, so the thing you are looking at can never be hidden from you
//
// Rename and "new group" happen inline, and their in-progress text is kept
// across re-renders — a stream event landing mid-typing must not wipe the box.

import { closePopover, miniConfirm, openMenu } from './popover.js?v=0.4.0';

/**
 * Commit an inline editor only when the user really left it.
 *
 * These inputs live inside a subtree that any SSE event can re-render, and
 * detaching a focused node fires `blur`. Committing on that blur means a
 * stream event landing while the "new group" box is open silently creates a
 * group named after the placeholder — something nobody asked for. If the node
 * is gone by the next tick, the blur was a re-render, not the user.
 */
function commitOnRealBlur(input, commit) {
  setTimeout(() => {
    if (!input.isConnected) return;
    commit();
  }, 0);
}

export class Sidebar {
  /**
   * @param {{ mount: HTMLElement, actions: Record<string, Function> }} opts
   */
  constructor({ mount, actions }) {
    this.mount = mount;
    this.actions = actions;
    this.expanded = new Set();
    this.collapsed = new Set();
    this.renameId = null;
    this.renameValue = '';
    this.draftOpen = false;
    this.draftValue = '';
    this.dragGroupId = null;
    this.dragChatId = null;
    /** Suppresses the click that is really the first half of a double-click. */
    this.ignoreClickUntil = 0;
    this.view = { groups: [], chats: [], activeChatId: null, activeGroupId: null };
  }

  // ------------------------------------------------------------ expansion

  groupOfActiveChat() {
    return this.view.chats.find((c) => c.id === this.view.activeChatId)?.groupId ?? null;
  }

  isExpanded(groupId) {
    if (!groupId) return false;
    if (groupId === this.groupOfActiveChat()) return true;
    if (this.collapsed.has(groupId)) return false;
    if (groupId === this.view.activeGroupId) return true;
    return this.expanded.has(groupId);
  }

  ensureExpanded(groupId) {
    if (!groupId) return;
    this.expanded.add(groupId);
    this.collapsed.delete(groupId);
  }

  toggleExpanded(groupId) {
    if (!groupId || groupId === this.groupOfActiveChat()) return;
    if (this.isExpanded(groupId)) {
      this.expanded.delete(groupId);
      this.collapsed.add(groupId);
    } else {
      this.ensureExpanded(groupId);
    }
    this.render(this.view);
  }

  chatsIn(groupId) {
    return this.view.chats.filter((c) => c.groupId === groupId);
  }

  // --------------------------------------------------------------- render

  render(view) {
    this.view = { ...this.view, ...view };
    const { groups } = this.view;
    this.mount.replaceChildren();

    if (!groups.length) {
      const empty = document.createElement('div');
      empty.className = 'side-empty';
      empty.textContent = 'ยังไม่มี group';
      this.mount.append(empty);
    }

    for (const group of groups) this.mount.append(this.groupBlock(group));

    if (this.draftOpen) this.mount.append(this.draftRow());
    this.mount.append(this.addGroupRow());
  }

  // ---------------------------------------------------------------- group

  groupBlock(group) {
    const chats = this.chatsIn(group.id);
    const running = chats.filter((c) => c.running).length;
    const pending = chats.reduce((n, c) => n + (c.pendingInteractions?.length || 0), 0);
    const expanded = this.isExpanded(group.id);

    const block = document.createElement('div');
    block.className =
      'group-block' +
      (group.id === this.view.activeGroupId ? ' active' : '') +
      (running ? ' has-running' : '') +
      (expanded ? ' is-expanded' : '');
    block.dataset.groupId = group.id;
    block.setAttribute('role', 'listitem');

    const row = document.createElement('div');
    row.className = 'group-row';

    const handle = document.createElement('span');
    handle.className = 'group-handle';
    handle.textContent = '⋮⋮';
    handle.title = 'ลากเพื่อเรียงลำดับ group';
    handle.draggable = true;
    handle.setAttribute('aria-hidden', 'true');
    row.append(handle);

    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'group-expand';
    expand.textContent = expanded ? '▾' : '▸';
    expand.title = expanded ? 'ยุบ' : 'ขยาย';
    expand.disabled = group.id === this.groupOfActiveChat();
    expand.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.toggleExpanded(group.id);
    });
    row.append(expand);

    const titleWrap = document.createElement('div');
    titleWrap.className = 'group-title-wrap';

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'group-name';
    name.textContent = group.name;
    name.title = `${group.name}\n${chats.length} session · ดับเบิลคลิก = เปลี่ยนชื่อ`;
    name.addEventListener('click', () => {
      if (this.ignoreClickUntil > Date.now()) return;
      this.ensureExpanded(group.id);
      this.actions.selectGroup(group.id);
    });
    name.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.ignoreClickUntil = Date.now() + 400;
      this.beginRename(group, titleWrap, name);
    });
    titleWrap.append(name);

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'group-btn add';
    add.textContent = '＋';
    add.title = 'เพิ่ม session ใน group นี้';
    add.setAttribute('aria-label', `เพิ่ม session ใน group ${group.name}`);
    add.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.ensureExpanded(group.id);
      this.actions.createChat(group.id);
    });
    titleWrap.append(add);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'group-btn del';
    del.textContent = '−';
    del.title = 'ลบ group';
    del.setAttribute('aria-label', `ลบ group ${group.name}`);
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      void this.confirmDeleteGroup(group, del);
    });
    titleWrap.append(del);
    row.append(titleWrap);

    const count = document.createElement('span');
    count.className = 'group-count' + (running ? ' running' : '');
    count.textContent = running ? `${running}/${chats.length}` : String(chats.length);
    count.title = running ? `${running} กำลังทำงาน · ${chats.length} session` : `${chats.length} session`;
    row.append(count);

    if (pending) {
      const badge = document.createElement('span');
      badge.className = 'group-pending';
      badge.textContent = String(pending);
      badge.title = 'รออนุมัติ';
      row.append(badge);
    }

    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'icon-btn group-menu';
    menu.textContent = '⋯';
    menu.title = 'เมนู group';
    menu.setAttribute('aria-haspopup', 'menu');
    menu.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.openGroupMenu(menu, group);
    });
    row.append(menu);

    block.append(row);

    if (this.renameId === group.id) this.beginRename(group, titleWrap, name, { focus: false });

    if (expanded) {
      const wrap = document.createElement('div');
      wrap.className = 'group-sessions';
      wrap.setAttribute('role', 'list');

      const foot = document.createElement('div');
      foot.className = 'group-sess-top';
      const addSess = document.createElement('button');
      addSess.type = 'button';
      addSess.className = 'dashed-tab';
      addSess.innerHTML = '<span class="plus">＋</span><span>session</span>';
      addSess.title = 'เพิ่ม session ใน group นี้';
      addSess.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.ensureExpanded(group.id);
        this.actions.createChat(group.id);
      });
      foot.append(addSess);
      wrap.append(foot);

      if (!chats.length) {
        const empty = document.createElement('div');
        empty.className = 'side-empty nested';
        empty.textContent = 'ยังไม่มี session';
        wrap.append(empty);
      } else {
        for (const chat of chats) wrap.append(this.chatRow(chat));
      }
      block.append(wrap);
    }

    this.wireGroupDnd(block, handle, group);
    return block;
  }

  // ----------------------------------------------------------------- chat

  chatRow(chat) {
    const pending = chat.pendingInteractions?.length || 0;
    const row = document.createElement('div');
    row.className =
      'session-item' +
      (chat.id === this.view.activeChatId ? ' active' : '') +
      (chat.running ? ' is-running' : '') +
      (pending ? ' has-pending' : '');
    row.dataset.id = chat.id;
    row.dataset.groupId = chat.groupId || '';
    row.setAttribute('role', 'listitem');
    row.draggable = true;
    row.title = `${chat.title}\nลากไปวางบน group อื่นเพื่อย้าย`;

    const pulse = document.createElement('span');
    pulse.className = 's-pulse' + (chat.running ? ' on' : chat.live ? ' live' : '');
    pulse.setAttribute('aria-hidden', 'true');
    row.append(pulse);

    // A <button> inside a <button> silently breaks clicks in WKWebView — the
    // row is a div and only the inner control is a button.
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'session-main';
    main.setAttribute('aria-label', `เปิด session ${chat.title}`);

    const title = document.createElement('span');
    title.className = 's-title';
    title.textContent = chat.title;
    main.append(title);

    const meta = document.createElement('span');
    meta.className = 's-meta';
    meta.textContent = chat.preview || `${chat.messageCount} ข้อความ`;
    main.append(meta);

    main.addEventListener('click', () => this.actions.selectChat(chat.id));
    row.append(main);

    if (pending) {
      const badge = document.createElement('span');
      badge.className = 's-badge';
      badge.textContent = String(pending);
      badge.title = 'รออนุมัติ';
      row.append(badge);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 's-del';
    del.textContent = '−';
    del.title = 'ลบ session';
    del.setAttribute('aria-label', `ลบ session ${chat.title}`);
    del.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const ok = await miniConfirm(del, `ลบ “${chat.title}” ?`, { okLabel: 'ลบ' });
      if (ok) this.actions.deleteChat(chat.id);
    });
    row.append(del);

    const menu = document.createElement('button');
    menu.type = 'button';
    menu.className = 'icon-btn s-menu';
    menu.textContent = '⋯';
    menu.title = 'เมนู session';
    menu.setAttribute('aria-haspopup', 'menu');
    menu.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.openChatMenu(menu, chat);
    });
    row.append(menu);

    row.addEventListener('dragstart', (ev) => {
      ev.stopPropagation();
      this.dragChatId = chat.id;
      this.dragGroupId = null;
      row.classList.add('dragging');
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', `chat:${chat.id}`);
      } catch { /* Safari can refuse setData; the id is already in state */ }
    });
    row.addEventListener('dragend', () => {
      this.dragChatId = null;
      row.classList.remove('dragging');
      this.clearDropHints();
    });

    return row;
  }

  // ------------------------------------------------------------------ dnd

  clearDropHints() {
    for (const n of this.mount.querySelectorAll('.drop-group, .drop-chat')) {
      n.classList.remove('drop-group', 'drop-chat');
    }
  }

  wireGroupDnd(block, handle, group) {
    handle.addEventListener('dragstart', (ev) => {
      ev.stopPropagation();
      this.dragGroupId = group.id;
      this.dragChatId = null;
      block.classList.add('dragging');
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', `group:${group.id}`);
      } catch { /* see above */ }
    });
    handle.addEventListener('dragend', () => {
      this.dragGroupId = null;
      block.classList.remove('dragging');
      this.clearDropHints();
    });

    block.addEventListener('dragover', (ev) => {
      if (this.dragChatId) {
        const chat = this.view.chats.find((c) => c.id === this.dragChatId);
        if (!chat || chat.groupId === group.id) return;
        ev.preventDefault();
        ev.dataTransfer.dropEffect = 'move';
        block.classList.add('drop-chat');
        return;
      }
      if (!this.dragGroupId || this.dragGroupId === group.id) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      block.classList.add('drop-group');
    });

    block.addEventListener('dragleave', (ev) => {
      if (block.contains(ev.relatedTarget)) return;
      block.classList.remove('drop-group', 'drop-chat');
    });

    block.addEventListener('drop', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      block.classList.remove('drop-group', 'drop-chat');

      if (this.dragChatId) {
        const chatId = this.dragChatId;
        this.dragChatId = null;
        this.ensureExpanded(group.id);
        this.actions.moveChat(chatId, group.id);
        return;
      }
      if (this.dragGroupId && this.dragGroupId !== group.id) {
        const moving = this.dragGroupId;
        this.dragGroupId = null;
        const order = this.view.groups.map((g) => g.id).filter((id) => id !== moving);
        const at = order.indexOf(group.id);
        order.splice(at < 0 ? order.length : at, 0, moving);
        this.actions.reorderGroups(order);
      }
    });
  }

  // ---------------------------------------------------------------- menus

  openGroupMenu(anchor, group) {
    const chats = this.chatsIn(group.id);
    const isLast = this.view.groups.length <= 1;
    openMenu(anchor, [
      { type: 'label', label: group.name },
      { label: 'เปิด group', icon: '▶', action: () => this.actions.selectGroup(group.id) },
      {
        label: 'Session ใหม่ใน group',
        icon: '＋',
        action: () => {
          this.ensureExpanded(group.id);
          this.actions.createChat(group.id);
        },
      },
      {
        label: 'เปลี่ยนชื่อ…',
        icon: '✎',
        action: () => {
          this.renameId = group.id;
          this.renameValue = group.name;
          this.render(this.view);
          this.mount.querySelector('.group-rename-input')?.focus();
          this.mount.querySelector('.group-rename-input')?.select();
        },
      },
      {
        label: this.isExpanded(group.id) ? 'ยุบ sessions' : 'ขยาย sessions',
        icon: this.isExpanded(group.id) ? '▴' : '▾',
        disabled: group.id === this.groupOfActiveChat(),
        action: () => this.toggleExpanded(group.id),
      },
      { type: 'sep' },
      {
        label: `ลบ group (${chats.length} session)`,
        icon: '−',
        danger: true,
        disabled: isLast,
        action: () => void this.confirmDeleteGroup(group, anchor),
      },
    ]);
  }

  openChatMenu(anchor, chat) {
    const others = this.view.groups.filter((g) => g.id !== chat.groupId);
    /** @type {any[]} */
    const items = [
      { type: 'label', label: chat.title },
      { label: 'เปิด session', icon: '▶', action: () => this.actions.selectChat(chat.id) },
      {
        label: 'คัดลอก session id',
        icon: 'id',
        action: () => void navigator.clipboard?.writeText(chat.id).catch(() => {}),
      },
      {
        // BUG-054: whole-transcript Markdown copy (grok-desktop's session
        // menu has "Copy all (Markdown)", app.js:6411-6418).
        label: 'คัดลอกทั้งหมด (Markdown)',
        icon: '⎘',
        action: () => this.actions.copyChatMarkdown(chat.id),
      },
    ];
    if (others.length) {
      items.push({ type: 'sep' }, { type: 'label', label: 'ย้ายไป group' });
      for (const g of others) {
        items.push({
          label: g.name,
          icon: '→',
          action: () => {
            this.ensureExpanded(g.id);
            this.actions.moveChat(chat.id, g.id);
          },
        });
      }
    }
    items.push(
      { type: 'sep' },
      {
        label: 'ลบ session',
        icon: '−',
        danger: true,
        action: async () => {
          const ok = await miniConfirm(anchor, `ลบ “${chat.title}” ?`, { okLabel: 'ลบ' });
          if (ok) this.actions.deleteChat(chat.id);
        },
      },
    );
    openMenu(anchor, items);
  }

  async confirmDeleteGroup(group, anchor) {
    if (this.view.groups.length <= 1) {
      await miniConfirm(anchor, 'ต้องเหลืออย่างน้อย 1 group', {
        okLabel: 'ตกลง',
        cancelLabel: null,
        infoOnly: true,
      });
      return;
    }
    const n = this.chatsIn(group.id).length;
    const ok = await miniConfirm(
      anchor,
      n ? `ลบ “${group.name}” และ ${n} session ข้างใน?` : `ลบ “${group.name}” ?`,
      { okLabel: 'ลบ' },
    );
    if (ok) this.actions.deleteGroup(group.id);
  }

  // --------------------------------------------------------------- inline

  /** Swap the group name button for a text field, in place. */
  beginRename(group, titleWrap, nameBtn, { focus = true } = {}) {
    if (titleWrap.querySelector('.group-rename-input')) return;
    // Reuse the buffered in-progress text only when it was typed for THIS
    // group — capture the id BEFORE overwriting it, or the test is dead and a
    // leftover from group A's abandoned rename pre-fills group B's box
    // (BUG-048; grok-desktop app.js:6506-6514 computes the start value before
    // assigning groupRenameId).
    const reuse = this.renameId === group.id && this.renameValue ? this.renameValue : group.name;
    this.renameId = group.id;
    this.renameValue = reuse;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-rename-input';
    input.value = reuse;
    input.maxLength = 80;
    input.setAttribute('aria-label', 'ชื่อ group');

    const commit = () => {
      const next = input.value.trim();
      this.renameId = null;
      this.renameValue = '';
      if (next && next !== group.name) this.actions.renameGroup(group.id, next);
      else this.render(this.view);
    };
    const cancel = () => {
      this.renameId = null;
      this.renameValue = '';
      this.render(this.view);
    };

    input.addEventListener('input', () => {
      this.renameValue = input.value;
    });
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', () => commitOnRealBlur(input, commit));

    nameBtn.replaceWith(input);
    if (focus) {
      input.focus();
      input.select();
    }
  }

  draftRow() {
    const wrap = document.createElement('div');
    wrap.className = 'group-block draft';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'group-rename-input draft-input';
    input.placeholder = 'ชื่อ group ใหม่';
    input.value = this.draftValue;
    input.maxLength = 80;

    const commit = () => {
      const name = input.value.trim();
      this.draftOpen = false;
      this.draftValue = '';
      if (name) this.actions.createGroup(name);
      else this.render(this.view);
    };
    const cancel = () => {
      this.draftOpen = false;
      this.draftValue = '';
      this.render(this.view);
    };

    input.addEventListener('input', () => {
      this.draftValue = input.value;
    });
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        ev.preventDefault();
        commit();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
      }
    });
    input.addEventListener('blur', () => commitOnRealBlur(input, commit));

    wrap.append(input);
    queueMicrotask(() => {
      input.focus();
      input.select();
    });
    return wrap;
  }

  addGroupRow() {
    const wrap = document.createElement('div');
    wrap.className = 'add-group';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dashed-tab dashed-group';
    btn.innerHTML = '<span class="plus">＋</span><span>group</span>';
    btn.title = 'เพิ่ม group ใหม่';
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closePopover();
      this.draftOpen = true;
      this.draftValue = this.draftValue || `Group ${this.view.groups.length + 1}`;
      this.render(this.view);
    });
    wrap.append(btn);
    return wrap;
  }
}
