const bcrypt = require('bcryptjs');

async function run() {
  const password = "Admin@123";

  const hash = await bcrypt.hash(password, 10);

  console.log("Password:", password);
  console.log("Bcrypt Hash:", hash);
}

run();