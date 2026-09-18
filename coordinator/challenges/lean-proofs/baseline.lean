-- The bar to beat. Tries the two things a beginner reaches for and nothing else.
macro "dmi_auto" : tactic => `(tactic| first | rfl | simp)
