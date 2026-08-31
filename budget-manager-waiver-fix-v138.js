// Budget manager waiver compatibility shim v1.7.2
// Legacy v1.3.8 logic has been retired.
// Manager waiver / revoke / final review are now handled by the unified controllers.
// Keep this module as an intentionally empty compatibility import so older modules
// can still import it without creating whole-document observers, polling timers,
// duplicate buttons, or duplicate confirmation dialogs.

export {};
