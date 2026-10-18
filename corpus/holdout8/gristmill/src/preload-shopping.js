// Shopping list preload. Sandboxed, so only 'electron' can be required here and the
// channel names are written out.
const { contextBridge, ipcRenderer } = require('electron')

const validChannels = [
  'shopping:items',
  'shopping:toggle',
  'shopping:clear',
  'shopping:changed',
  'shopping:export',
]

const shoppingAPI = {
  send: (channel, data) => {
    // allowed channels
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data)
    }
  },
  request: (channel, data) => {
    if (validChannels.includes(channel)) {
      return ipcRenderer.invoke(channel, data)
    }
    return Promise.reject(new Error(`Blocked channel ${channel}`))
  },
  receive: (channel, callback) => {
    if (validChannels.includes(channel)) {
      const newCallback = (_, data) => callback(data)
      ipcRenderer.on(channel, newCallback)
    }
  },
  platform: process.platform,
}

contextBridge.exposeInMainWorld('shopping', shoppingAPI)

window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('app-window:mounted')
})
