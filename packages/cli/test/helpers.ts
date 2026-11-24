import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest } from "../src/manifest.js";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(here, "../../..");
export const EXAMPLE_DIR = resolve(REPO, "examples/todo");
export const EXAMPLE_MANIFEST = resolve(EXAMPLE_DIR, "omnintent.json");
export const GENERATED_DIR = resolve(EXAMPLE_DIR, "generated");

export function loadExample(): Manifest {
  return JSON.parse(readFileSync(EXAMPLE_MANIFEST, "utf8")) as Manifest;
}

/** A deep copy of the example, changed by `edit`. */
export function variant(edit: (m: Manifest) => void): Manifest {
  const m = structuredClone(loadExample());
  edit(m);
  return m;
}

/** A small manifest with a payment action, for safety-mapping tests. */
export function paymentManifest(): Manifest {
  return {
    omnintent: "0.1",
    app: {
      name: "Coffee Shop",
      slug: "coffee-shop",
      description: "Orders coffee for pickup at a nearby store.",
      android: { packageName: "com.example.coffee" },
    },
    backend: { baseUrl: "<YOUR_BACKEND_URL>", auth: { type: "bearer", secret: "BACKEND_TOKEN" } },
    entities: {
      Order: {
        type: "object",
        title: "Order",
        description: "A coffee order.",
        privacy: "personal",
        idProperty: "id",
        displayProperty: "summary",
        properties: {
          id: { type: "string", description: "The order ID." },
          summary: { type: "string", description: "What was ordered, for example \"Large latte\"." },
          cardLast4: { type: "string", description: "The last four digits of the card used.", privacy: "sensitive" },
        },
        required: ["id", "summary"],
      },
    },
    actions: [
      {
        name: "place_order",
        title: "Place Order",
        description: "Places and pays for a coffee order for pickup and returns the order.",
        safety: "payment",
        confirmation: { prompt: "Pay for {drink} now?" },
        inputSchema: {
          type: "object",
          properties: {
            drink: { type: "string", title: "Drink", description: "The drink to order, for example \"latte\"." },
            size: { type: "string", title: "Size", description: "Cup size.", enum: ["small", "large"], default: "small" },
          },
          required: ["drink"],
          additionalProperties: false,
        },
        outputSchema: { $ref: "#/entities/Order" },
        backend: { method: "POST", path: "/orders" },
        examples: [
          { utterance: "Order a latte", arguments: { drink: "latte" } },
          { utterance: "Get me a large mocha", arguments: { drink: "mocha", size: "large" } },
        ],
      },
    ],
  };
}
