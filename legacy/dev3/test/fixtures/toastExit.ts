// No native notifications: exercises the real subprocess transport and exit-code mapping.
const code = Number(process.argv[2]);
if (code === 99) setInterval(() => {}, 1000);
else setTimeout(() => process.exit(code), 20);
