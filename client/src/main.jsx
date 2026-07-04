import React from "react";
import { createRoot } from "react-dom/client";
import { SocketFiProvider } from "@socketfi/react";
import App from "./App.jsx";
import "./App.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <SocketFiProvider
      config={{
        clientId: "sf_client_live_1blpukbhctwu5je45zlndqeed5pr",
        guardians: ["GBYV5SISEH5DNG2U56E6Y6DPT7C3WSR6NHO6QHT27ECWYRX66HQTAHHP"],
        network: "TESTNET",
        brand: {
          appName: "SocketFi Transfer Template",
        },
      }}
    >
      <App />
    </SocketFiProvider>
  </React.StrictMode>
);
