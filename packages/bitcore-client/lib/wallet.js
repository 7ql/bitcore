const Bcrypt = require('bcrypt');
const Encrypter = require('./encryption');
const Mnemonic = require('bitcore-mnemonic');
const bitcoreLib = require('bitcore-lib');
const Client = require('./client');
const Storage = require('./storage');
const txProvider = require('../lib/providers/tx-provider');

class Wallet {
  constructor(params) {
    Object.assign(this, params);
    if (!this.masterKey) {
      return new Wallet(this.create(params));
    }
    this.baseUrl =
      this.baseUrl || `http://127.0.0.1:3000/api/${this.chain}/${this.network}`;
  }

  saveWallet() {
    return this.storage.saveWallet({ wallet: this });
  }

  static async create(params) {
    const { chain, network, name, phrase, password, path } = params;
    if (!chain || !network || !name || !path) {
      throw new Error('Missing required parameter');
    }
    const mnemonic = new Mnemonic(phrase);
    const privateKey = mnemonic.toHDPrivateKey(password);
    const pubKey = privateKey.hdPublicKey.publicKey.toString();
    const masterKey = Encrypter.generateEncryptionKey();
    const keyObj = Object.assign(
      privateKey.toObject(),
      privateKey.hdPublicKey.toObject()
    );
    const encryptionKey = Encrypter.encryptEncryptionKey(masterKey, password);
    const encPrivateKey = Encrypter.encryptPrivateKey(
      JSON.stringify(keyObj),
      pubKey,
      masterKey
    );
    const storage = new Storage({
      path,
      errorIfExists: true,
      createIfMissing: true
    });
    const wallet = Object.assign(params, {
      encryptionKey,
      masterKey: encPrivateKey,
      password: await Bcrypt.hash(password, 10),
      xPubKey: keyObj.xpubkey,
      pubKey
    });
    await storage.saveWallet({ wallet });
    const loadedWallet = await this.loadWallet({ path, storage });
    await loadedWallet.unlock(password);
    await loadedWallet.register();
    return loadedWallet;
  }

  static async loadWallet(params) {
    const { path } = params;
    const storage =
      params.storage ||
      new Storage({ path, errorIfExists: false, createIfMissing: false });
    const loadedWallet = await storage.loadWallet();
    return new Wallet(Object.assign(loadedWallet, { storage }));
  }

  async unlock(password) {
    const encMasterKey = this.masterKey;
    let validPass = await Bcrypt.compare(password, this.password).catch(
      () => false
    );
    if (!validPass) {
      throw new Error('Incorrect Password');
    }
    this.encryptionKey = await Encrypter.decryptEncryptionKey(
      this.encryptionKey,
      password
    );
    const masterKeyStr = await Encrypter.decryptPrivateKey(
      encMasterKey,
      this.pubKey,
      this.encryptionKey
    );
    this.masterKey = JSON.parse(masterKeyStr);
    this.unlocked = true;
    this.client = new Client({
      baseUrl: this.baseUrl,
      authKey: this.getAuthSigningKey()
    });

    return this;
  }

  async register(params = {}) {
    const { baseUrl } = params;
    if (baseUrl) {
      this.baseUrl = baseUrl;
      await this.saveWallet();
    }
    const payload = {
      name: this.name,
      pubKey: this.masterKey.xpubkey,
      path: this.derivationPath,
      network: this.network,
      chain: this.chain
    };
    return this.client.register({ payload });
  }

  getAuthSigningKey() {
    return new bitcoreLib.HDPrivateKey(this.masterKey.xprivkey).deriveChild(
      'm/2'
    ).privateKey;
  }

  getBalance(params) {
    return this.client.getBalance({ pubKey: this.masterKey.xpubkey });
  }

  getUtxos(params) {
    return this.client.getCoins({
      pubKey: this.masterKey.xpubkey,
      includeSpent: false
    });
  }

  async newTx(params) {
    const payload = {
      network: this.network,
      chain: this.chain,
      addresses: params.addresses,
      amount: params.amount,
      utxos: params.utxos || (await this.getUtxos(params)),
      change: params.change,
      fee: params.fee
    };
    return txProvider.create(payload);
  }

  async broadcast(params) {
    const payload = {
      network: this.network,
      chain: this.chain,
      rawTx: params.tx
    };
    return this.client.broadcast({ payload });
  }

  async importKeys(params) {
    const { keys, password } = params;
    if (password) {
      await this.unlock(password);
    }
    const encryptionKey = this.unlocked ? this.encryptionKey : null;
    for (const key of keys) {
      let keyToSave = { key, encryptionKey };
      await this.storage.addKey(keyToSave);
    }
    const addedAddresses = keys.map(key => {
      return { address: key.address };
    });
    if (this.unlocked) {
      return this.client.importAddresses({
        pubKey: this.xPubKey,
        payload: addedAddresses
      });
    }
  }

  async signTx(params) {
    let { tx } = params;
    const utxos = await this.getUtxos(params);
    const payload = {
      chain: this.chain,
      network: this.network,
      tx,
      utxos
    };
    let inputAddresses = txProvider.getSigningAddresses(payload);
    let keyPromises = inputAddresses.map(address => {
      return this.storage.getKey({ address });
    });
    let keys = await Promise.all(keyPromises);
    return txProvider.sign({ ...payload, keys });
  }
}

module.exports = Wallet;