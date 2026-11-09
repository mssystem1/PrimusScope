import { mutateFixture } from "./fixture";

const action = process.argv[2];
if (action !== "advance" && action !== "repeat" && action !== "fail" && action !== "recover") {
  throw new Error("Choose a supported synthetic indexed E2E writer action.");
}
process.stdout.write(JSON.stringify(mutateFixture(action)));
