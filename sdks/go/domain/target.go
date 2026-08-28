package domain

// TargetKind names what is being registered (spec/remote-register-target.schema.json).
type TargetKind string

const (
	TargetKindUser   TargetKind = "user"
	TargetKindDevice TargetKind = "device"
)
