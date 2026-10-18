// Shopping list. Still plain JavaScript (allowJs), from before the TypeScript move.
const { ipcMain: ipc } = require('electron')
const { store } = require('../store')
const { library } = require('../library')
const { IPC_CHANNELS } = require('../../common/channels')
const windows = require('../windows')

function readItems () {
  return store.get('shopping.items', [])
}

function notify (items) {
  const win = windows.getShoppingWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('shopping:changed', items)
  }
}

function writeItems (items) {
  store.set('shopping.items', items)
  notify(items)
}

function scale (line, factor) {
  return line.replace(/^(\d+(?:\.\d+)?)/, function (n) {
    return String(Math.round(parseFloat(n) * factor * 100) / 100)
  })
}

function registerShoppingHandlers () {
  ipc.handle(IPC_CHANNELS.SHOPPING_ADD, function (e, { recipeId, servings }) {
    const recipe = library.get(recipeId)
    if (!recipe) {
      return readItems()
    }
    const factor = servings / (recipe.servings || 4)
    const added = recipe.ingredients.map(function (line) {
      return { text: scale(line, factor), recipe: recipe.title, checked: false }
    })
    const items = readItems().concat(added)
    writeItems(items)
    return items
  })

  ipc.on(IPC_CHANNELS.SHOPPING_OPEN, function () {
    windows.openShoppingList()
  })

  ipc.handle('shopping:items', function () {
    return readItems()
  })

  ipc.on('shopping:toggle', function (e, { index }) {
    const items = readItems()
    if (items[index]) {
      items[index].checked = !items[index].checked
      writeItems(items)
    }
  })

  ipc.on('shopping:clear', function () {
    store.delete('shopping.items')
    notify([])
  })
}

module.exports = { registerShoppingHandlers }
