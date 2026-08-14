import { rvaOf } from "../../state/address";
import type { Annotations } from "../../state/annotations";

// Resolve an absolute function address to its display name (custom or IDA-style sub_*),
// going through the module's RVA the way the rest of the static view does. Shared by the
// call-graph and stats panels so they label functions identically to the function list.
export function functionLabel(
    annotations: Annotations,
    module: string,
    base: string,
    address: string,
): string {
    return annotations.nameOf(module, rvaOf(base, address));
}
