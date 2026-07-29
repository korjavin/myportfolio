package mcpshim

// The mcp_help / mcp_call argument envelopes. The `jsonschema` tags are what
// the SDK advertises to the model, so a dropped field is a field no agent can
// ever pass — and the decoder on the other side is
// web/static/js/core/mcp-responder.js (bd myportfolio-ybp.4), which has to
// agree with these names.
//
// Deliberately smaller than medicationtrackerbot's equivalent: v1 is
// READ-ONLY (ARCHITECTURE.md §11), so there is no body, no mode and no
// intent. Writes get their own bead and their own consent surface, and a
// field advertised here is a field the model will try — "the model misread
// the units and booked a sell" starts with a `mode: write` the schema
// offered it.

// HelpInput is mcp_help's argument shape. Without it the SDK advertises no
// arguments at all and the agent can never drill in past the terse catalog.
type HelpInput struct {
	OperationID  string   `json:"operation_id,omitempty" jsonschema:"one operation id to return in full, with its params_schema"`
	OperationIDs []string `json:"operation_ids,omitempty" jsonschema:"several operation ids to return in full, with their params_schema"`
	Topic        string   `json:"topic,omitempty" jsonschema:"list only this topic's operations, e.g. performance"`
	Query        string   `json:"query,omitempty" jsonschema:"keyword-search the catalog, e.g. dividends"`
}

// CallInput is mcp_call's argument shape.
type CallInput struct {
	OperationID string         `json:"operation_id" jsonschema:"the operation id from mcp_help's catalog, e.g. portfolio.holdings"`
	Params      map[string]any `json:"params,omitempty" jsonschema:"parameters for the operation, per its params_schema in mcp_help"`
}
