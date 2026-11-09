// Demo attribution only. This module does not authenticate anyone or grant permissions.
// Production must obtain and verify the actor from a server-side authenticated session.
export const DEMO_SESSION_KEY = 'routenote-ui-preview:actor:v1';
export class DemoSessionRequiredError extends Error {
  constructor() {
    super('利用者を選び直してください。入力中の内容は残しています。');
    this.name = 'DemoSessionRequiredError';
  }
}

export function createDemoSession({ getStorage = () => globalThis.sessionStorage } = {}) {
  let memberId = '', storageAvailable = true;
  const write = () => {
    try {
      const storage = getStorage();
      if (memberId) storage.setItem(DEMO_SESSION_KEY, JSON.stringify({ memberId }));
      else storage.removeItem(DEMO_SESSION_KEY);
      storageAvailable = true;
    } catch { storageAvailable = false; }
  };
  try {
    const raw = getStorage().getItem(DEMO_SESSION_KEY);
    if (raw !== null) {
      const saved = JSON.parse(raw);
      if (saved && typeof saved.memberId === 'string') memberId = saved.memberId;
      else write();
    }
  } catch {
    storageAvailable = false;
    // An unreadable demo selection must never reset or modify report storage.
  }
  return {
    current(state) {
      const member = state?.masters?.members?.find(m => m.id === memberId && m.active) ?? state?.masters?.members?.find(m=>m.active);
      if (!member && memberId) { memberId = ''; write(); }
      return member ?? null;
    },
    require(state) {
      const member = this.current(state);
      if (!member) throw new DemoSessionRequiredError();
      return member;
    },
    select(state, id) {
      const member = state?.masters?.members?.find(m => m.id === id && m.active);
      if (!member) throw new DemoSessionRequiredError();
      memberId = member.id;
      write();
      return member;
    },
    clear() { memberId = ''; write(); },
    get storageAvailable() { return storageAvailable; },
  };
}
