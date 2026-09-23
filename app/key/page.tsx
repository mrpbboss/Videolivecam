"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function KeyPage() {
  const router = useRouter();
  const [key, setKey] = useState("");

  const saveKey = () => {
    if (!key.trim()) return;
    localStorage.setItem("user_api_key", key.trim());
    router.push("/");
  };

  return (
    <div style={{ padding: 40, color: "#e6edf3", background: "#0b0f17", height: "100vh" }}>
      <h2>Enter Your API Key</h2>
      <p style={{ opacity: 0.7, marginBottom: 20 }}>
        Paste your Xmax API key below to activate the app.
      </p>

      <input
        type="password"
        placeholder="Enter API Key"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        style={{
          width: "100%",
          padding: 12,
          borderRadius: 8,
          background: "#1f2937",
          color: "#e6edf3",
          border: "none",
          marginBottom: 20
        }}
      />

      <button
        onClick={saveKey}
        style={{
          padding: "10px 20px",
          background: "#2563eb",
          border: "none",
          borderRadius: 8,
          color: "white",
          cursor: "pointer"
        }}
      >
        Save Key
      </button>
    </div>
  );
}
