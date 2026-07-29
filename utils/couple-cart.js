const { callCloud } = require('./cloud');

let cartCache = {
  items: [],
  version: 0,
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const getCart = async (force = false) => {
  if (!force && cartCache.version > 0) return clone(cartCache.items);
  cartCache = await callCloud('dataApi', 'getCart');
  return clone(cartCache.items);
};

const saveCart = async (items) => {
  cartCache = await callCloud('dataApi', 'updateCart', {
    expectedVersion: cartCache.version || null,
    items: items.map((item) => ({ id: item.id, quantity: item.quantity })),
  });
  return clone(cartCache.items);
};

const addToCart = async (item) => {
  const cart = await getCart();
  const target = cart.find((cartItem) => cartItem.id === item.id);
  if (target) {
    target.quantity += 1;
  } else {
    cart.push({ id: item.id, quantity: 1 });
  }
  return saveCart(cart);
};

const updateQuantity = async (id, quantity) => {
  const cart = (await getCart())
    .map((item) => (item.id === id ? { ...item, quantity } : item))
    .filter((item) => item.quantity > 0);
  return saveCart(cart);
};

const clearCart = () => saveCart([]);

const createOrder = async (note) => {
  const result = await callCloud('dataApi', 'createOrder', {
    note,
    requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
  cartCache = { items: [], version: cartCache.version + 1 };
  return result;
};

const getOrders = async (limit = 20) => {
  const { orders } = await callCloud('dataApi', 'getOrders', { limit });
  return orders;
};

const getPersonalOrders = async (limit = 20) => {
  const { orders } = await callCloud('dataApi', 'getPersonalOrders', { limit });
  return orders;
};

const updateOrder = (orderId, operation, response = '') =>
  callCloud('dataApi', 'updateOrder', {
    operation,
    orderId,
    response,
  });

const clearCartCache = () => {
  cartCache = { items: [], version: 0 };
};

module.exports = {
  addToCart,
  clearCart,
  clearCartCache,
  createOrder,
  getCart,
  getOrders,
  getPersonalOrders,
  updateOrder,
  updateQuantity,
};
