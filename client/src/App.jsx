import React, { useState } from "react";
import { useSocketFi } from "@socketfi/react";
import {
  Asset,
  Contract,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

const NETWORK = "TESTNET";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const RPC_URL = "https://soroban-testnet.stellar.org";

function getXlmContractId() {
  return Asset.native().contractId(NETWORK_PASSPHRASE);
}

function normalizeTokenAddress(tokenInput) {
  const value = tokenInput.trim();

  if (!value) throw new Error("Enter a token contract address");
  if (value.toUpperCase() === "XLM") return getXlmContractId();

  return value;
}

function toTokenAmount(value, decimals = 7) {
  const amount = Number(value || "0");

  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Enter a valid amount");
  }

  return BigInt(Math.floor(amount * 10 ** decimals));
}

function buildTransferArgsXdr({ from, to, amount }) {
  return [
    nativeToScVal(from, { type: "address" }),
    nativeToScVal(to, { type: "address" }),
    nativeToScVal(amount, { type: "i128" }),
  ].map((arg) => arg.toXDR("base64"));
}

async function readTokenBalance({ tokenContractId, address }) {
  const health = await fetch(`${SERVER_URL}/health`).then((r) => r.json());

  const server = new rpc.Server(RPC_URL);
  const sourceAccount = await server.getAccount(health.paymaster);
  const contract = new Contract(tokenContractId);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call("balance", nativeToScVal(address, { type: "address" }))
    )
    .setTimeout(60)
    .build();

  const simulation = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(simulation.error);
  }

  return BigInt(scValToNative(simulation.result.retval).toString());
}

async function fundWithFriendbot(account) {
  const response = await fetch(`${SERVER_URL}/friendbot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account }),
  });

  const data = await response.json();

  if (!data.success) {
    throw new Error(
      typeof data.error === "string" ? data.error : JSON.stringify(data.error)
    );
  }

  return data.data;
}

export default function App() {
  const socketfi = useSocketFi();

  const [wallet, setWallet] = useState("");
  const [accessToken, setAccessToken] = useState("");

  const [tokenInput, setTokenInput] = useState(
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"
  );
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");

  const [status, setStatus] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const isConnected = Boolean(wallet);
  const isXlm =
    tokenInput.trim().toUpperCase() ===
    "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  async function connectWallet() {
    setLoading(true);
    setStatus("");
    setResult(null);

    try {
      const data = await socketfi.authenticate("signin");

      setWallet(data.session.address[NETWORK]);
      setAccessToken(data.session.socketfiAccessToken);
      setStatus("Wallet connected");
    } catch (error) {
      setStatus(error.message || "Wallet connection failed");
    } finally {
      setLoading(false);
    }
  }

  async function validateBalance({ tokenContractId, amountStroops }) {
    const balance = await readTokenBalance({
      tokenContractId,
      address: wallet,
    });

    if (balance < amountStroops) {
      throw new Error(
        `Insufficient balance. Balance: ${balance.toString()}, required: ${amountStroops.toString()}`
      );
    }
  }

  function buildTransferPayload() {
    if (!wallet) throw new Error("Connect wallet first");
    if (!recipient.trim()) throw new Error("Enter recipient address");

    const tokenContractId = normalizeTokenAddress(tokenInput);
    const amountStroops = toTokenAmount(amount);

    return {
      tokenContractId,
      amountStroops,
      argsXdr: buildTransferArgsXdr({
        from: wallet,
        to: recipient.trim(),
        amount: amountStroops,
      }),
    };
  }

  async function transferWithSocketFiSubmit() {
    setLoading(true);
    setStatus("");
    setResult(null);

    try {
      const { tokenContractId, amountStroops, argsXdr } =
        buildTransferPayload();

      await validateBalance({ tokenContractId, amountStroops });

      const response = await socketfi.signAndSubmitTx({
        contractId: tokenContractId,
        callFunction: { name: "transfer" },
        argsXdr,
        accessToken,
      });

      setStatus("Transfer submitted with SocketFi");
      setResult(response);
    } catch (error) {
      setStatus(error.message || "Transfer failed");
    } finally {
      setLoading(false);
    }
  }

  async function transferWithBackendSubmit() {
    setLoading(true);
    setStatus("");
    setResult(null);

    try {
      const { tokenContractId, amountStroops, argsXdr } =
        buildTransferPayload();

      await validateBalance({ tokenContractId, amountStroops });

      const signed = await socketfi.signTx({
        contractId: tokenContractId,
        callFunction: { name: "transfer" },
        argsXdr,
        accessToken,
        clientPaymaster: "SERVER_SIDE_PAYMASTER",
      });

      const signedAuthEntriesXdr =
        signed.signedAuthEntriesXdr ?? signed.data?.signedAuthEntriesXdr;

      if (!Array.isArray(signedAuthEntriesXdr)) {
        throw new Error("Missing signedAuthEntriesXdr");
      }

      const submitResponse = await fetch(
        `${SERVER_URL}/submit-signed-transfer`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contractId: tokenContractId,
            functionName: "transfer",
            argsXdr,
            signedAuthEntriesXdr,
          }),
        }
      );

      const data = await submitResponse.json();

      if (!data.success) {
        throw new Error(data.error || "Backend submit failed");
      }

      setStatus("Transfer submitted by backend paymaster");
      setResult(data.data);
    } catch (error) {
      setStatus(error.message || "Transfer failed");
    } finally {
      setLoading(false);
    }
  }

  async function fundPaymasterWithFriendbot() {
    setLoading(true);
    setStatus("");
    setResult(null);

    try {
      const health = await fetch(`${SERVER_URL}/health`).then((r) => r.json());
      const response = await fundWithFriendbot(wallet);

      setStatus("Backend paymaster funded with Friendbot");
      setResult(response);
    } catch (error) {
      setStatus(error.message || "Friendbot funding failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <section className="card">
        <div>
          <p className="eyebrow">SocketFi Transfer Template</p>
          <h1>Transfer tokens with a SocketFi smart wallet</h1>
          <p className="subtitle">
            Connect a SocketFi wallet, then transfer XLM or any Soroban token.
          </p>
        </div>

        <div className="box">
          <p className="label">Connected wallet</p>
          <p className="mono">{wallet || "Not connected"}</p>
        </div>

        {!isConnected ? (
          <button className="button" onClick={connectWallet} disabled={loading}>
            {loading ? "Connecting..." : "Connect SocketFi wallet"}
          </button>
        ) : (
          <>
            <div className="grid">
              <label>
                Token contract address
                <input
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder='Use "XLM" or paste token contract ID'
                />
              </label>

              <label>
                Recipient address
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Recipient G... or C... address"
                />
              </label>

              <label>
                Amount
                <input
                  type="number"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
              </label>
            </div>

            {isXlm && (
              <button
                className="secondaryButton"
                onClick={fundPaymasterWithFriendbot}
                disabled={loading}
              >
                Fund backend paymaster with Friendbot
              </button>
            )}

            <div className="actions">
              <button
                className="button"
                onClick={transferWithSocketFiSubmit}
                disabled={loading}
              >
                {loading ? "Processing..." : "signAndSubmitTx"}
              </button>

              <button
                className="button"
                onClick={transferWithBackendSubmit}
                disabled={loading}
              >
                {loading ? "Processing..." : "signTx + backend submit"}
              </button>
            </div>
          </>
        )}

        {status && <div className="status">{status}</div>}
        {result && <pre>{JSON.stringify(result, null, 2)}</pre>}
      </section>
    </main>
  );
}
