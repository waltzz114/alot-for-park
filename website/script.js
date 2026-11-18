const slotsEl = document.getElementById("slots");
const noticeEl = document.getElementById("notice");
const countEl = document.getElementById("availableCount");

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

async function loadSlots() {
  try {
    const response = await fetch("/api/slots");

    if (!response.ok) {
      throw new Error("Server returned " + response.status);
    }

    const data = await response.json();
    const slots = data.slots || [];

    countEl.textContent = slots
      .filter(s => s.status === "AVAILABLE")
      .length.toString()
      .padStart(2, "0");

    slotsEl.innerHTML = slots.map(s => {
      const status = s.status.toLowerCase();

      const label =
        s.status === "OCCUPIED" ? "OCCUPIED" :
        s.status === "RESERVED" ? "RESERVED" :
        s.status === "PENDING_PAYMENT" ? "PAYMENT PENDING" :
        "AVAILABLE";

      const description =
        s.status === "AVAILABLE" ? "Ready to reserve" :
        s.status === "PENDING_PAYMENT" ? "Awaiting payment confirmation" :
        s.status === "RESERVED" ? "Payment confirmed · Awaiting arrival" :
        "Vehicle detected";

      const button = s.status === "AVAILABLE"
        ? `<button onclick="bookSlot(${Number(s.slot)})">Reserve for ₹1</button>`
        : "";

      const cssStatus =
        s.status === "PENDING_PAYMENT" ? "reserved" : status;

      return `
        <article class="slot ${esc(cssStatus)}">
          <div>
            <h3>Parking ${Number(s.slot)}</h3>
            <p>${esc(description)}</p>
            ${button}
          </div>
          <span class="tag">${esc(label)}</span>
        </article>
      `;
    }).join("");

  } catch (e) {
    slotsEl.innerHTML =
      '<p class="error">Unable to connect to the parking server. Please retry.</p>';

    countEl.textContent = "—";
  }
}

async function bookSlot(slot) {
  noticeEl.textContent = "Creating your secure ₹1 reservation…";

  try {
    const response = await fetch("/api/bookings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ slot })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Could not create booking");
    }

    if (!data.checkoutUrl) {
      throw new Error("Checkout URL was not returned by the server");
    }

    window.location.href = data.checkoutUrl;

  } catch (e) {
    noticeEl.textContent = e.message;
    await loadSlots();
  }
}

document.getElementById("refresh")
  .addEventListener("click", loadSlots);

loadSlots();

// Refresh availability every five seconds.
setInterval(loadSlots, 5000);
