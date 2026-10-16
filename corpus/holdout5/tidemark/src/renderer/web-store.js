// Web storage of the editor page. Every key carries the prefix "tidemark.".

const PREFIX = "tidemark.";
const key = (name) => `${PREFIX}${name}`;

export const local = {
  get: (name) => localStorage.getItem(key(name)),
  set: (name, value) => localStorage.setItem(key(name), String(value)),
  remove: (name) => localStorage.removeItem(key(name)),
};

export const session = {
  get: (name) => sessionStorage.getItem(key(name)),
  set: (name, value) => sessionStorage.setItem(key(name), String(value)),
};
