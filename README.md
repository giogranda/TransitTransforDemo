# HashiCorp Vault Demo Guide  
**Vault 1.19.5 · Node.js UI · Transit + Transform**

This guide walks you from **zero → fully working demo**, matching the **current, working state**:

- Transit engine demo (encrypt/decrypt, SQLite persistence)
- Transform engine demo:
  - Format-Preserving Encryption (deterministic)
  - Tokenization
  - Data masking
- Node.js UI
- Vault 1.19.5–compatible

---

## Prerequisites

### Required
- HashiCorp Vault **1.19.5**
- Node.js **18+**

### Verify
```bash
vault version
node --version
```

---

## Step 1: Start Vault (Dev Mode)

```bash
vault server -dev
```

In a second terminal, export the values printed by Vault:

```bash
export VAULT_ADDR="http://127.0.0.1:8200"
export VAULT_TOKEN="s.xxxxxxxx"
```

---

## Step 2: Enable Transit Engine and Create a Key

```bash
vault secrets enable transit
vault write transit/keys/demo-key
```

This key is used by the **Transit demo page**.

---

## Step 3: Enable Transform Engine

```bash
vault secrets enable transform
```

---

## Step 4: Create Alphabet (Digits Only)

```bash
vault write transform/alphabet/numerics alphabet="0123456789"
```

---

## Step 5: Create SSN Template

This template matches SSNs in the format `123-45-6789`.

```bash
vault write transform/template/ssn \
  type=regex \
  pattern='^([0-9]{3})-([0-9]{2})-([0-9]{4})$' \
  encode_format='$1-$2-$3' \
  decode_formats=full='$1-$2-$3' \
  alphabet=numerics
```

---

## Step 6: Create Transform Role

```bash
vault write transform/role/ssn-demo \
  transformations=ssn_fpe,ssn_tokenize,ssn_mask
```

---

## Step 7: Create Transformations

### 7.1 Format-Preserving Encryption (Deterministic)

```bash
vault write transform/transformations/fpe/ssn_fpe \
  template=ssn \
  tweak_source=supplied \
  allowed_roles=ssn-demo
```

---

### 7.2 Tokenization

```bash
vault write -force transform/transformations/tokenization/ssn_tokenize \
  allowed_roles=ssn-demo
```

---

### 7.3 Data Masking

Masking is **one-way** and produces `XXX-XX-XXXX`.

```bash
vault write transform/transformations/masking/ssn_mask \
  template=ssn \
  masking_character="X" \
  allowed_roles=ssn-demo
```

---

## Step 8: Validate Transform Behavior (CLI)

### Create Fixed Deterministic Tweak (7 bytes)

```bash
export SSN_TWEAK_B64="$(printf 'SSNDEMO' | base64)"
```

---

### FPE Encode (Run Twice — Output Must Match)

```bash
vault write transform/encode/ssn-demo \
  transformation=ssn_fpe \
  value="123-45-6789" \
  tweak="$SSN_TWEAK_B64"
```

Run it again — the `encoded_value` must be identical.

---

### FPE Decode

```bash
vault write transform/decode/ssn-demo \
  transformation=ssn_fpe \
  value="<ENCODED_VALUE>" \
  tweak="$SSN_TWEAK_B64"
```

---

### Tokenization

```bash
vault write transform/encode/ssn-demo \
  transformation=ssn_tokenize \
  value="123-45-6789"
```

---

### Masking

```bash
vault write transform/encode/ssn-demo \
  transformation=ssn_mask \
  value="123-45-6789"
```

Expected:
```
XXX-XX-XXXX
```

---

## Step 9: Set Up Node.js Demo App

### Create Project

```bash
mkdir vault-demo
cd vault-demo
npm init -y
npm install express better-sqlite3
```

---

### Download `server.js`

Download `server.js` and place into the working directory

---

## Step 10: Start the Demo Application

```bash
export VAULT_ADDR="http://127.0.0.1:8200"
export VAULT_TOKEN="s.xxxxxxxx"

export TRANSIT_KEY="demo-key"

export TRANSFORM_ROLE="ssn-demo"
export TF_FPE="ssn_fpe"
export TF_TOK="ssn_tokenize"
export TF_MASK="ssn_mask"

export SSN_TWEAK_B64="$(printf 'SSNDEMO' | base64)"

node server.js
```

Expected:
```
Demo running on http://localhost:3000
```

---

## Step 11: Use the Demo

### Transit Demo

Open in browser:

```
http://localhost:3000
```

- Encrypt plaintext
- Store ciphertext in SQLite
- Toggle plaintext vs ciphertext views
- Decrypt on demand

---

### Transform Demo

Open in browser:

```
http://localhost:3000/transform
```

Input:
```
123-45-6789
```

You will see:

- **FPE:** deterministic SSN-shaped ciphertext
- **Tokenization:** token value
- **Masking:** `XXX-XX-XXXX`
- Decode available for FPE and tokenization
- Masking is irreversible (no decode)

---
