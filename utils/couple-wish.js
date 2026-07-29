const { callCloud } = require('./cloud');

let cartCache = {
  items: [],
  version: 0,
};
let cartFetchedAt = 0;
const CART_TTL_MS = 45 * 1000;

let ordersCache = {
  at: 0,
  limit: 0,
  orders: null,
};
let personalOrdersCache = {
  at: 0,
  limit: 0,
  orders: null,
};
const ORDERS_TTL_MS = 45 * 1000;

const clone = (value) => JSON.parse(JSON.stringify(value));

const getCart = async (force = false) => {
  const fresh = cartFetchedAt > 0 && Date.now() - cartFetchedAt < CART_TTL_MS;
  if (!force && fresh) return clone(cartCache.items);
  cartCache = await callCloud('dataApi', 'getCart');
  cartFetchedAt = Date.now();
  return clone(cartCache.items);
};

const saveCart = async (items) => {
  cartCache = await callCloud('dataApi', 'updateCart', {
    expectedVersion: cartCache.version || null,
    items: items.map((item) => ({ id: item.id, quantity: item.quantity })),
  });
  cartFetchedAt = Date.now();
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

const invalidateOrdersCache = () => {
  ordersCache = { at: 0, limit: 0, orders: null };
  personalOrdersCache = { at: 0, limit: 0, orders: null };
};

const createOrder = async (note) => {
  const result = await callCloud('dataApi', 'createOrder', {
    note,
    requestId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  });
  cartCache = { items: [], version: cartCache.version + 1 };
  cartFetchedAt = Date.now();
  invalidateOrdersCache();
  return result;
};

const getOrders = async (limit = 20, force = false) => {
  const fresh =
    ordersCache.orders &&
    ordersCache.limit >= limit &&
    Date.now() - ordersCache.at < ORDERS_TTL_MS;
  if (!force && fresh) return clone(ordersCache.orders).slice(0, limit);
  const { orders } = await callCloud('dataApi', 'getOrders', { limit });
  ordersCache = { at: Date.now(), limit, orders };
  return clone(orders);
};

const getPersonalOrders = async (limit = 20, force = false) => {
  const fresh =
    personalOrdersCache.orders &&
    personalOrdersCache.limit >= limit &&
    Date.now() - personalOrdersCache.at < ORDERS_TTL_MS;
  if (!force && fresh) return clone(personalOrdersCache.orders).slice(0, limit);
  const { orders } = await callCloud('dataApi', 'getPersonalOrders', { limit });
  personalOrdersCache = { at: Date.now(), limit, orders };
  return clone(orders);
};

const updateOrder = async (orderId, operation, response = '') => {
  const result = await callCloud('dataApi', 'updateOrder', {
    operation,
    orderId,
    response,
  });
  invalidateOrdersCache();
  return result;
};

const clearCartCache = () => {
  cartCache = { items: [], version: 0 };
  cartFetchedAt = 0;
  invalidateOrdersCache();
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
