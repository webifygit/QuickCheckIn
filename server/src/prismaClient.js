const { PrismaClient } = require('@prisma/client');

// Created lazily, so requiring this module (from tests, scripts or tooling)
// does not open a database connection on its own.
let client;

function getPrisma() {
  if (!client) client = new PrismaClient();
  return client;
}

// Tests swap in a stand-in client. Nothing in the app calls this.
function setPrisma(next) {
  client = next;
}

const prisma = new Proxy(
  { getPrisma, setPrisma },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      const active = getPrisma();
      const value = active[prop];
      return typeof value === 'function' ? value.bind(active) : value;
    },
  }
);

module.exports = prisma;
