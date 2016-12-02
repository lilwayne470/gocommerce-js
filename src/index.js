import API from "micro-api-client";

const HTTPRegexp = /^http:\/\//;
const cartKey = "netlify.commerce.shopping-cart";
const vatnumbers = {};

function checkRole(user, role) {
  return user && user.roles && user.roles.filter((r) => r == role)[0];
}

function getPrice(prices, currency, user) {
  return prices
    .filter((price) => currency == (price.currency || "USD").toUpperCase())
    .filter((price) => price.role ? checkRole(user) : true)
    .sort((a, b) => a.amount - b.amount)[0];
}

function applyTax(price, quantity, percentage) {
  const cents = parseInt(parseFloat(price.amount) * quantity * 100);
  const tax = cents * (percentage / 100);
  return {
    amount: centsToAmount(tax),
    cents: tax,
    currency: price.currency
  };
}

function getTax(item, taxes, country) {
  if (item.vat) {
    return applyTax(item.price, item.quantity, parseInt(item.vat, 10));
  }
  if (taxes && country && item.type) {
    for (let i = 0, len = taxes.length; i < len; i ++) {
      if (taxes[i].product_types.includes(item.type) && taxes[i].countries.includes(country)) {
        return applyTax(item.price, item.quantity, taxes[i].percentage);
      }
    }
  }
  return {amount: "0.00", cents: 0, currency: item.price.currency};
}

function centsToAmount(cents) {
  return `${(Math.round(cents) / 100).toFixed(2)}`;
}

export default class NetlifyCommerce {
  constructor(options) {
    if (!options.APIUrl) {
      throw("You must specify an APIUrl of your Netlify Commerce instance");
    }
    if (options.APIUrl.match(HTTPRegexp)) {
      console.log('Warning:\n\nDO NOT USE HTTP IN PRODUCTION FOR NETLIFY COMMERCE EVER!\NETLIFY COMMERCE REQUIRES HTTPS to work securely.')
    }

    this.api = new API(options.APIUrl);
    this.currency = options.currency || "USD";
    this.billing_country = options.country;
    this.settings_path = "/netlify-commerce/settings.json";
    this.settings_refresh_period = options.settingsRefreshPeriod || (10 * 60 * 1000);
    this.loadCart();
  }

  setUser(user) {
    this.user = user;
  }

  addToCart(item) {
    const {path, quantity, meta} = item;
    if (quantity && path) {
      return fetch(path).then((response) => {
        if (!response.ok) { return Promise.reject(`Failed to fetch ${path}`); }

        return response.text().then((html) => {
          const doc = document.implementation.createHTMLDocument("product");
          doc.documentElement.innerHTML = html;
          const product = JSON.parse(doc.getElementById("netlify-commerce-product").innerHTML);
          const {sku, title, prices, description, type, vat} = product;
          if (sku && title && prices) {
            if (this.line_items[sku]) {
              this.line_items[sku].quantity += quantity;
            } else {
              this.line_items[sku] = Object.assign(product, {path, meta, quantity});
            }
            return this.loadSettings().then(() => {
              this.persistCart();
              return this.getCart();
            });
          } else {
            return Promise.reject("Failed to read sku, title and price from product path");
          }
        });
      });
    } else {
      return Promise.reject("Invalid item - must have path and quantity");
    }
  }

  getCart() {
    const cart = {
      subtotal: {amount: "", cents: 0, currency: this.currency},
      taxes: {amount: "", cents: 0, currency: this.currency},
      total: {amount: "", cents: 0, currency: this.currency},
      items: {}
    };
    for (const key in this.line_items) {
      const item = cart.items[key] = Object.assign({}, this.line_items[key], {
        price: getPrice(this.line_items[key].prices, this.currency, this.user)
      });
      item.tax = getTax(item, this.settings && this.settings.taxes, this.billing_country);
      cart.subtotal.cents += parseFloat(item.price.amount * item.quantity * 100);
      cart.taxes.cents += parseFloat(item.tax.amount * 100);
    }
    cart.subtotal.amount = centsToAmount(cart.subtotal.cents);
    if (this.vatnumber_valid) {
      cart.taxes = {amount: "0.00", cents: 0, currency: this.currency};
    } else {
      cart.taxes.amount = centsToAmount(cart.taxes.cents);
    }
    cart.total.cents = cart.subtotal.cents + cart.taxes.cents;
    cart.total.amount = centsToAmount(cart.total.cents);
    return cart;
  }

  setCurrency(currency) {
    this.currency = currency;
    return Promise.resolve(this.getCart());
  }

  setCountry(country) {
    this.billing_country = country;
    return Promise.resolve(this.getCart());
  }

  setVatnumber(vatnumber) {
    this.vatnumber = vatnumber;
    return this.verifyVatnumber(vatnumber).then(() => this.getCart());
  }

  updateCart(sku, quantity) {
    if (this.line_items[sku]) {
      if (quantity > 0) {
        this.line_items[sku].quantity = quantity;
      } else {
        delete this.line_items[sku];
      }
      this.persistCart();
    } else {
      throw(`Item ${sku} not found in cart`);
    }
  }

  clearCart() {
    this.line_items = {};
    this.persistCart();
  }

  order(orderDetails) {
    const {
      email,
      shipping_address, shipping_address_id,
      billing_address, billing_address_id,
      data
    } = orderDetails;

    if (email && (shipping_address || shipping_address_id)) {
      const line_items = [];
      for (const id in this.line_items) {
        line_items.push(this.line_items[id]);
      }

      return this.authHeaders().then((headers) => this.api.request("/orders", {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          email,
          shipping_address, shipping_address_id,
          billing_address, billing_address_id,
          vatnumber: this.vatnumber_valid ? this.vatnumber : null,
          currency: this.currency,
          data,
          line_items
        })
      })).then((order) => {
        const cart = this.getCart();
        this.clearCart();
        return {cart, order};
      });
    } else {
      return Promise.reject(
        "Invalid orderDetails - must have an email and either a shipping_address or shipping_address_id"
      );
    }
  }

  payment(paymentDetails) {
    const {order_id, amount, stripe_token, paypal_payment_id, paypal_user_id} = paymentDetails;
    if (order_id && amount && (stripe_token || (paypal_payment_id && paypal_user_id))) {
      const cart = this.getCart();
      return this.authHeaders().then((headers) => this.api.request(`/orders/${order_id}/payments`, {
        method: "POST",
        headers: headers,
        body: JSON.stringify({
          amount,
          order_id,
          stripe_token,
          paypal_payment_id,
          paypal_user_id,
          currency: this.currency
        })
      }));
    } else {
      return Promise.reject(
        "Invalid paymentDetails - must have an order_id, an amount and a stripe_token or a paypal_payment_id and paypal_user_id"
      );
    }
  }

  paypalPaymentInfo(paymentID) {
    return this.api.request(`/paypal/${paymentID}`);
  }

  claimOrders() {
    if (this.user) {
      return this.authHeaders().then((headers) => this.api.request("/claim", {
        headers,
        method: "POST"
      }));
    }
    return Promise.resolve(null);
  }

  orderHistory() {
    if (this.user) {
      return this.authHeaders().then((headers) => this.api.request("/orders", {
        headers
      }));
    } else {
      return Promise.reject(
        "You must be authenticated to fetch order history"
      );
    }
  }

  authHeaders() {
    if (this.user) {
      return this.user.jwt().then((token) => ({Authorization: `Bearer ${token}`}));
    }
    return Promise.resolve({});
  }

  loadCart() {
    const json = localStorage.getItem(cartKey);
    if (json) {
      const cart = JSON.parse(json);
      this.settings = cart.settings;
      this.line_items = cart.line_items || {};
    } else {
      this.settings = null;
      this.line_items = {};
    }
  }

  loadSettings() {
    if (this.settingsAreFresh()) { return Promise.resolve(); }

    return fetch(this.settings_path).then((response) => {
      if (!response.ok) { return; }

      return response.json().then((json) => {
        this.settings = Object.assign(json, {ts: new Date().getTime()});
      });
    });
  }

  settingsAreFresh() {
    if (this.settings_path == null) { return true; }

    if (this.settings) {
      const diff = new Date().getTime() - this.settings.ts;
      return diff < this.settings_refresh_period;
    }

    return false;
  }

  verifyVatnumber(vatnumber) {
    this.vatnumber_valid = false;
    if (!vatnumber) {
      this.vatnumber_valid = false;
      return Promise.resolve(false);
    }
    if (vatnumbers[vatnumber]) {
      this.vatnumber_valid = vatnumbers[vatnumber].valid;
      return Promise.resolve(false);
    }

    return this.api.request(`/vatnumbers/${vatnumber}`).then((response) => {
      vatnumbers[vatnumber] = response;
      this.vatnumber_valid = response.valid;
      return response.valid;
    });
  }

  persistCart() {
    const json = JSON.stringify({line_items: this.line_items, settings: this.settings});
    localStorage.setItem(cartKey, json);
  }
}

if (typeof window !== "undefined") {
  window.NetlifyCommerce = NetlifyCommerce
}
