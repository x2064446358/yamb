const fs = require('fs').promises
const path = require('path')

class Whitelist {
  constructor (filePath) {
    this.filePath = filePath
    this.data = {}
  }

  async load () {
    try {
      const content = await fs.readFile(this.filePath, 'utf-8')
      this.data = JSON.parse(content)
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.data = {}
        await this.save()
      } else {
        throw err
      }
    }
  }

  async save () {
    await fs.writeFile(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  async add (gameName, addedBy) {
    this.data[gameName] = {
      addedBy: addedBy || 'system',
      addedAt: new Date().toISOString()
    }
    await this.save()
  }

  async remove (gameName) {
    delete this.data[gameName]
    await this.save()
  }

  isAllowed (gameName) {
    return gameName in this.data
  }

  get (gameName) {
    return this.data[gameName] || null
  }

  list () {
    return { ...this.data }
  }

  count () {
    return Object.keys(this.data).length
  }
}

module.exports = Whitelist
