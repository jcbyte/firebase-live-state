import {
	Database,
	DatabaseReference,
	DataSnapshot,
	get,
	onChildAdded,
	onChildRemoved,
	onValue,
	ref,
	Unsubscribe,
	update,
} from "firebase/database";
import diff, { Difference } from "microdiff";
import { useEffect, useRef, useState } from "react";

type PrimitiveListener = { unsubscribeUpdate: Unsubscribe };
type ObjectListener = { unsubscribeAdd: Unsubscribe; unsubscribeRemove: Unsubscribe };
type Listener = ({ primitive: true } & PrimitiveListener) | ({ primitive: false } & ObjectListener);

/**
 * Returns a stateful value synchronised with a Firebase Realtime Database at a given path, and a function to update it.
 * @param {Database} db Realtime Database instance.
 * @param {string | null} path Path in Database to synchronise with state variable.
 * @returns {[T | undefined, (updater: (newObject: T) => T) => void]}
 *   - The state variable.
 *   - Function to update the state and sync changes to Firebase.
 */
export default function useLiveState<T>(
	db: Database,
	path: string | null
): [T | undefined, (updater: (newObject: T) => T) => void] {
	// Underlying stateful value
	const [object, setObject] = useState<T | undefined>(undefined);
	// Hashmap of all relative paths and there corresponding listeners so we can unsubscribe from them where necessary
	const listenersRef = useRef<Record<string, Listener>>({});

	// Keep path as a ref in case it is changed from null dynamically.
	// This could be wanted as to not begin loading data until it's existence is confirmed.
	const pathRef = useRef<string | null>(path);

	/**
	 * Normalises a path by removing/adding slashes.
	 * @param {string} path The input path.
	 * @returns {string} The normalized path.
	 */
	function normalisePath(path: string): string {
		return `/${path.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/")}`;
	}

	/**
	 * Joins path segments into a single path.
	 * @param {(string | number)[]} pathItems The segments of the path.
	 * @returns {string} The collapsed path.
	 */
	function joinPathSegments(pathItems: (string | number)[]): string {
		return normalisePath(pathItems.join("/"));
	}

	/**
	 * Retrieves the number of path components in a given path.
	 * @param {string} path The path.
	 * @returns {number} The number of path components.
	 */
	function countPathSegments(path: string): number {
		const normalisedPath = normalisePath(path);
		return normalisedPath === "/" ? 0 : normalisedPath.split("/").length - 1;
	}

	/**
	 * Recursively construct the path from a DatabaseReference.
	 * @param {DatabaseReference} ref The database reference.
	 * @returns {string[]} - The individual extracted path components.
	 */
	function deriveRelativeRefPath(ref: DatabaseReference, _path: string[] = []): string[] {
		if (!ref.parent) {
			// Remove the extra components of the path to make it relative
			const extraSegments = pathRef.current ? countPathSegments(pathRef.current) : 0;
			return _path.slice(extraSegments);
		}

		return deriveRelativeRefPath(ref.parent, [ref.key ?? "", ..._path]);
	}

	/**
	 * Creates listeners for changes in the Firebase Realtime Database at the given snapshot's path.
	 * Will ensure that listeners only created once.
	 * @param {DataSnapshot} snapshot The snapshot at the specific path to create listeners.
	 */
	function createListeners(snapshot: DataSnapshot) {
		// If data does not exist at the path then do not create listeners here
		if (!snapshot.exists()) return;

		// Find the path for the given snapshot
		const path = deriveRelativeRefPath(snapshot.ref);
		const pathKey = joinPathSegments(path);

		// Only create listeners if they do not already exist
		if (pathKey in listenersRef.current) return;

		// Determine if the snapshot contains an object or a primitive value
		if (snapshot.hasChildren()) {
			// Add listeners for when children are added or removed from the object
			const addListener = onChildAdded(snapshot.ref, (snapshot: DataSnapshot) => {
				handleChildAdded(snapshot, path);
			});
			const removeListener = onChildRemoved(snapshot.ref, (snapshot: DataSnapshot) => {
				handleChildRemoved(snapshot, path);
			});

			// This will create listeners for the entire object as when an `onChildAdded` lister is created, it immediately executes
			// the callback for all of its children.

			listenersRef.current[pathKey] = {
				primitive: false,
				unsubscribeAdd: addListener,
				unsubscribeRemove: removeListener,
			};
		} else {
			// Add listeners for when the primitive value changes
			const changeListener = onValue(snapshot.ref, (snapshot: DataSnapshot) => {
				handleValueChange(snapshot, path);
			});

			listenersRef.current[pathKey] = { primitive: true, unsubscribeUpdate: changeListener };
		}
	}

	/**
	 * Unsubscribe listeners at a given path.
	 * @param {string} pathKey The path of the listeners to remove.
	 */
	function unsubscribeListeners(pathKey: string) {
		if (!(pathKey in listenersRef.current)) return;

		const listeners = listenersRef.current[pathKey];
		// Unsubscribe listeners based on value type
		if (listeners.primitive) {
			listeners.unsubscribeUpdate();
		} else {
			listeners.unsubscribeAdd();
			listeners.unsubscribeRemove();
		}
	}

	/**
	 * Handles a change from the realtime database of a node's value.
	 * @param {DataSnapshot} snapshot The snapshot of the changed data, hence containing the singular new value.
	 * @param {string[]} path The path to the changed node.
	 */
	function handleValueChange(snapshot: DataSnapshot, path: string[]) {
		// Update state variable with this change
		setObject((prev) => {
			const newObject = structuredClone(prev);

			// Iterate through the object until we reach the value which was changed
			path.reduce((objectAt: any, key, index) => {
				// If the local parent object doest exist yet then temporarily create it to ensure local structure
				// The order of callbacks should ensure this exists but React state setting is asynchronous so this may not be the case
				if (!(key in objectAt)) {
					objectAt[key] = {};
				}

				// Update the value at reference
				if (index == path.length - 1) {
					objectAt[key] = snapshot.val();
				}

				return objectAt[key];
			}, newObject);

			return newObject;
		});
	}

	/**
	 * Handles a new child added from the realtime database at a specific path.
	 * @param {DataSnapshot} snapshot The snapshot of the new data.
	 * @param {string[]} path The path to the parent node.
	 */
	function handleChildAdded(snapshot: DataSnapshot, path: string[]) {
		// Update state variable with this change
		setObject((prev) => {
			const newObject = structuredClone(prev);

			// Iterate through the object until we reach the parent object
			const objectAtPath = path.reduce((objectAt: any, key) => {
				// If the local parent object doest exist yet then temporarily create it to ensure local structure
				// The order of callbacks should ensure this exists but React state setting is asynchronous so this may not be the case
				if (!(key in objectAt)) {
					objectAt[key] = {};
				}

				return objectAt[key];
			}, newObject);

			// Add the new children to the parent
			objectAtPath[snapshot.ref.key!] = snapshot.val();
			// Create listeners for these objects so they are also synchronised
			createListeners(snapshot);

			return newObject;
		});
	}

	/**
	 * Handles a child being removed from the realtime database at a specific path.
	 * @param {DataSnapshot} snapshot The snapshot containing reference to parent whose child was removed.
	 * @param {string[]} path The path to the parent node.
	 */
	function handleChildRemoved(snapshot: DataSnapshot, path: string[]) {
		// Update state variable with this change
		setObject((prev) => {
			const newObject = structuredClone(prev);

			// Iterate through the object until we reach the parent object
			const objectAtPath = path.reduce((objectAt: any, key) => {
				return [objectAt[key]];
			}, newObject);

			// Delete the child at the parent
			delete objectAtPath[snapshot.ref.key!];

			// Unsubscribe from the listeners created so we don't receive phantom callbacks
			const itemPathKey = joinPathSegments([...path, snapshot.ref.key!]);
			unsubscribeListeners(itemPathKey);
			// Delete the listener reference from our internal list
			delete listenersRef.current[itemPathKey];

			return newObject;
		});
	}

	// Initialise the hook by fetching data from Firebase at the given path and setting up listeners
	useEffect(() => {
		async function init() {
			// If the path is null do not initialise
			if (!path) return;

			const snapshot: DataSnapshot = await get(ref(db, path));
			// If data does not exist at the path then do not initialise
			if (!snapshot.exists()) return;

			setObject(snapshot.val());
			// Create listeners for the entire object
			createListeners(snapshot);
		}
		init();

		pathRef.current = path;
	}, [db, path]);

	/**
	 * Applies a batch of changes to the realtime database
	 * @param {Difference[]} changes Array of differences representing the changes to be applied.
	 */
	function writeChanges(changes: Difference[]) {
		const updates: Record<string, any> = {};

		// For each change create a database update
		changes.forEach((change) => {
			// Calculate the realtime database path, remove the first element from path as that will always be [0]
			const changePath = `${pathRef.current}${joinPathSegments(change.path.slice(1))}`;

			if (change.type === "REMOVE") {
				// Setting to `null` will delete from the database
				updates[changePath] = null;
			} else {
				updates[changePath] = change.value;
			}
		});

		// Send all updates at once
		update(ref(db), updates);
	}

	/**
	 * Update the local state and synchronise changes with the Realtime Database.
	 * @param {(newObject: T) => T} updater Updater function which receives the current state object and returns the updated object.
	 */
	function updateObject(updater: (newObject: T) => T) {
		// If an empty object ({}, []) is written then the state variable will be updated but not the live database
		// This shouldn't matter as `diff` will also not pick up on these changes until data is actually written inside this object

		// Update state variable with this change
		setObject((prev) => {
			// Calculate the new object by running the updater
			const newObject = updater(prev as T);

			// Find changes and update the realtime database with them, must pass as objects hence passes as arrays
			const changes = diff([prev], [newObject]);
			writeChanges(changes);

			return newObject;
		});
	}

	return [object, updateObject];
}
