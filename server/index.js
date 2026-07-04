// server/index.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const StellarSdk = require("@stellar/stellar-sdk");

const { rpc, xdr } = StellarSdk;

const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 4000;
const RPC_URL =
  process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK =
  process.env.STELLAR_NETWORK === "PUBLIC"
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;

const PAYMASTER_SECRET_KEY = process.env.PAYMASTER_SECRET_KEY;

if (!PAYMASTER_SECRET_KEY) {
  throw new Error("PAYMASTER_SECRET_KEY is required");
}

const paymaster = StellarSdk.Keypair.fromSecret(PAYMASTER_SECRET_KEY);

function buildInvokeTx({ sourceAccount, contractId, functionName, argsXdr }) {
  const contract = new StellarSdk.Contract(contractId);

  const args = (argsXdr || []).map((argXdr) =>
    xdr.ScVal.fromXDR(argXdr, "base64")
  );

  return new StellarSdk.TransactionBuilder(sourceAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: NETWORK,
  })
    .addOperation(contract.call(functionName, ...args))
    .setTimeout(60)
    .build();
}

async function waitForTransaction(server, hash) {
  for (let i = 0; i < 30; i++) {
    const result = await server.getTransaction(hash);

    if (result.status === "SUCCESS") return result;

    if (result.status === "FAILED") {
      throw new Error(`Transaction failed: ${JSON.stringify(result)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  throw new Error(`Timed out waiting for transaction: ${hash}`);
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    paymaster: paymaster.publicKey(),
    network: process.env.STELLAR_NETWORK || "TESTNET",
  });
});

app.post("/submit-signed-transfer", async (req, res) => {
  try {
    const { contractId, functionName, argsXdr, signedAuthEntriesXdr } =
      req.body;

    if (!contractId || !functionName || !Array.isArray(argsXdr)) {
      return res.status(400).json({
        success: false,
        error: "contractId, functionName, and argsXdr are required",
      });
    }

    if (!Array.isArray(signedAuthEntriesXdr)) {
      return res.status(400).json({
        success: false,
        error: "signedAuthEntriesXdr is required",
      });
    }

    const server = new rpc.Server(RPC_URL);

    const sourceForFunction = await server.getAccount(paymaster.publicKey());

    const functionTx = buildInvokeTx({
      sourceAccount: sourceForFunction,
      contractId,
      functionName,
      argsXdr,
    });

    const invokeOp = functionTx.operations[0];

    const signedAuthEntries = signedAuthEntriesXdr.map((entryXdr) =>
      xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64")
    );

    const freshSourceForSubmit = await server.getAccount(paymaster.publicKey());

    const txWithSignedAuth = new StellarSdk.TransactionBuilder(
      freshSourceForSubmit,
      {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: NETWORK,
      }
    )
      .addOperation(
        StellarSdk.Operation.invokeHostFunction({
          func: invokeOp.func,
          auth: signedAuthEntries,
        })
      )
      .setTimeout(60)
      .build();

    const simulation = await server.simulateTransaction(txWithSignedAuth);

    if (rpc.Api.isSimulationError(simulation)) {
      throw new Error(simulation.error);
    }

    const assembled = rpc
      .assembleTransaction(txWithSignedAuth, simulation)
      .build();

    assembled.sign(paymaster);

    const submitted = await server.sendTransaction(assembled);

    if (submitted.status === "ERROR") {
      return res.status(400).json({
        success: false,
        error: "Transaction submission failed",
        errorResultXdr: submitted.errorResult?.toXDR?.("base64"),
      });
    }

    const finalResult = await waitForTransaction(server, submitted.hash);

    return res.json({
      success: true,
      data: {
        hash: submitted.hash,
        status: finalResult.status,
      },
    });
  } catch (error) {
    console.error("[submit-signed-transfer]", error);

    return res.status(400).json({
      success: false,
      error: error.message || "Failed to submit transaction",
    });
  }
});

app.post("/friendbot", async (req, res) => {
  try {
    const { account } = req.body;

    if (!account) {
      return res.status(400).json({
        success: false,
        error: "account is required",
      });
    }

    const url = `https://friendbot.stellar.org?addr=${encodeURIComponent(
      account
    )}`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(400).json({
        success: false,
        error: data,
      });
    }

    return res.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("[friendbot]", error);

    return res.status(400).json({
      success: false,
      error: error.message || "Friendbot request failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Paymaster: ${paymaster.publicKey()}`);
});
