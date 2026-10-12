export const CUSTOMER_CONTACT_KEY = 'sam-contact:v1';

function normalizedContact(value, savedAt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.name !== 'string' || typeof value.phone !== 'string'
    || !Number.isSafeInteger(savedAt) || savedAt <= 0) return null;
  const name = value.name.trim();
  let phone = value.phone.replace(/[\s()（）-]/g, '');
  if (phone.startsWith('+86')) phone = phone.slice(3);
  else if (phone.startsWith('0086')) phone = phone.slice(4);
  else if (/^86\d{11}$/.test(phone)) phone = phone.slice(2);
  if (!name || name.length > 40 || !/^1[3-9]\d{9}$/.test(phone)) return null;
  return { version: 1, name, phone, savedAt };
}

export function readCustomerContact(storage) {
  try {
    const value = JSON.parse(storage.getItem(CUSTOMER_CONTACT_KEY));
    return value?.version === 1 ? normalizedContact(value, value.savedAt) : null;
  } catch { return null; }
}

export function saveCustomerContact(storage, payload, submittedAt = Date.now()) {
  const contact = normalizedContact(payload, submittedAt);
  if (!contact) return null;
  const existing = readCustomerContact(storage);
  // An interrupted older order may finish after a newer order in another tab.
  if (existing && existing.savedAt > submittedAt) return existing;
  try {
    storage.setItem(CUSTOMER_CONTACT_KEY, JSON.stringify(contact));
    return contact;
  } catch { return null; }
}

export function clearCustomerContact(storage) {
  try { storage.removeItem(CUSTOMER_CONTACT_KEY); return true; }
  catch { return false; }
}

export function initialCustomerForm(pending, contact) {
  const payload = pending?.payload;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      name: typeof payload.name === 'string' ? payload.name : '',
      phone: typeof payload.phone === 'string' ? payload.phone : '',
      note: typeof payload.note === 'string' ? payload.note : '',
    };
  }
  return { name: contact?.name || '', phone: contact?.phone || '', note: '' };
}
