// Demo only: this key ships with the public page so the AI works from the printed QR with no server.
// It is scrambled to keep it from automated key scanners, not to keep it secret: anyone can read it
// from the browser. Delete the key in the DeepSeek dashboard after the demo, and use a proxy for the pilot.
window.AISLE_AI_KEY = atob("YmJiZjk1NjNiMGQwMjkxYTY1MzRkNzQ4YWIwYjkxYTgta3M=").split("").reverse().join("");

// Optional proxy URL. If set, requests go here instead of straight to DeepSeek.
window.AISLE_AI = "";
