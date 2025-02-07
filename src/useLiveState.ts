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
	 * @param path The path.
	 * @returns THe number of path components.
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

	// todo tsdoc
	function createListeners(snapshot: DataSnapshot) {
		if (!snapshot.exists()) return;

		const path = deriveRelativeRefPath(snapshot.ref);
		const pathKey = joinPathSegments(path);

		// Only create listeners if they do not already exist
		if (pathKey in listenersRef.current) return;

		if (snapshot.hasChildren()) {
			// This is an object
			const addListener = onChildAdded(snapshot.ref, (snapshot: DataSnapshot) => {
				handleChildAdded(snapshot, path);
			});
			const removeListener = onChildRemoved(snapshot.ref, (snapshot: DataSnapshot) => {
				handleChildRemoved(snapshot, path);
			});

			listenersRef.current[pathKey] = {
				primitive: false,
				unsubscribeAdd: addListener,
				unsubscribeRemove: removeListener,
			};
		} else {
			const changeListener = onValue(snapshot.ref, (snapshot: DataSnapshot) => {
				handleValueChange(snapshot, path);
			});
			listenersRef.current[pathKey] = { primitive: true, unsubscribeUpdate: changeListener };
		}
	}

	// todo tsdoc
	function unsubscribeListeners(pathKey: string) {
		if (!(pathKey in listenersRef.current)) return;

		const listeners = listenersRef.current[pathKey];
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
			// If d ata does not exist at the path then do not initialise
			if (!snapshot.exists()) return;

			setObject(snapshot.val());
			// This will create listeners for the entire object as when an `onChildAdded` lister is created, it immediately executes
			// the callback for all of its children.
			createListeners(snapshot);
		}
		init();

		pathRef.current = path;
	}, [db, path]);

	// todo tsdoc
	const writeChanges = (changes: Difference[]) => {
		const updates: Record<string, any> = {};

		changes.forEach((change) => {
			const changePath = `${pathRef.current}${joinPathSegments(change.path.slice(1))}`;

			if (change.type === "CREATE" || change.type === "CHANGE") {
				updates[changePath] = change.value;
			} else {
				updates[changePath] = null;
			}
		});

		update(ref(db), updates);
	};

	// If an empty object is written ({}, []) then the state variable will be updated but not the live database
	// This shouldn't matter as `diff` will also not pick up on these changes until data is actually written inside this object
	// todo tsdoc
	function updateObject(updater: (newObject: T) => T) {
		setObject((prev) => {
			const newObject = updater(prev as T);
			const changes = diff([prev], [newObject]);
			writeChanges(changes);
			return newObject;
		});
	}

	return [object, updateObject];
}
