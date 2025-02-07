# firebase-live-state

Provides a React hook for synchronising a state variable with a [Firebase Realtime Database](https://firebase.google.com/docs/database) at a given path.

## Installation

```bash
npm install firebase-live-state
```

## Usage

Ensure that your Firebase Realtime Database security rules allow read and write access to the path you're synchronising with.

Initialise firebase, and get the Realtime Database instance:

```ts
import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseApp = initializeApp({
	/* your config */
});
const db = getDatabase(firebaseApp);
```

Use `useLiveState` to create your synchronised state variable and setter:

```ts
import { useLiveState } from "firebase-live-state";

export default function YourComponent() {
	const [obj, setObj] = useLiveState<T>(db, "/firebase/path");

	function increment() {
		setObj((prev) => {
			return {...prev, count: prev.count + 1};
		});
	}

	return (
		<div onClick={increment}>
			Count: {obj ? obj.count : "Loading..." :}
		</div>
	);
}
```

The state object will initially be `undefined` until the data at the specified path has been fetched.

The Realtime Database and state variable will stay synchronized. Any changes made to the state variable or the Firebase Realtime Database will reflect in the other automatically.

### Limitations

⚠️ **There must already be data in the Firebase Realtime Database at the given path to initialise correctly.** Without data, the state will remain as `undefined` permanently.

State updates must be done using functional state updates (e.g., `setObj((prev) => {...})`).

## Licence

MIT Licence

## Authors

- [@jcbyte](https://www.github.com/jcbyte)
