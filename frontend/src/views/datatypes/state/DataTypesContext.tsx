import { createContext, useContext, type JSX } from "solid-js";
import { createDataTypesStore, type DataTypesState } from "../../../state/dataTypesStore";

// Thin context wrapper around the global data-type registry. The store itself is created once here
// (under the provider's reactive owner, so persist()'s effect has an owner) and shared with every
// datatypes tab plus any consumer that wants to resolve a named struct/enum.

const DataTypesContext = createContext<DataTypesState>();

export function DataTypesProvider(props: { children: JSX.Element }) {
    const state = createDataTypesStore();
    return <DataTypesContext.Provider value={state}>{props.children}</DataTypesContext.Provider>;
}

export function useDataTypes(): DataTypesState {
    const state = useContext(DataTypesContext);
    if (!state) throw new Error("useDataTypes must be used within a DataTypesProvider");
    return state;
}
