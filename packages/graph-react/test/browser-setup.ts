import { configure } from "@testing-library/dom";

// The first React Flow render in a fresh browser worker can exceed the
// 1000 ms default on Windows CI runners before nodes become visible.
configure({ asyncUtilTimeout: 5_000 });
