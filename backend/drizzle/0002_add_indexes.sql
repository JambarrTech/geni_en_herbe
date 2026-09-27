CREATE INDEX "match_questions_match_id_idx" ON "match_questions" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "match_questions_question_id_idx" ON "match_questions" USING btree ("question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "match_questions_match_question_unique" ON "match_questions" USING btree ("match_id","question_id");--> statement-breakpoint
CREATE INDEX "match_questions_winning_team_id_idx" ON "match_questions" USING btree ("winning_team_id");--> statement-breakpoint
CREATE INDEX "matches_event_id_idx" ON "matches" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "matches_team_a_id_idx" ON "matches" USING btree ("team_a_id");--> statement-breakpoint
CREATE INDEX "matches_team_b_id_idx" ON "matches" USING btree ("team_b_id");--> statement-breakpoint
CREATE INDEX "matches_jury_id_idx" ON "matches" USING btree ("jury_id");--> statement-breakpoint
CREATE INDEX "matches_timer_is_running_idx" ON "matches" USING btree ("timer_is_running");--> statement-breakpoint
CREATE INDEX "matches_event_match_number_idx" ON "matches" USING btree ("event_id","match_number");--> statement-breakpoint
CREATE INDEX "participants_school_id_idx" ON "participants" USING btree ("school_id");--> statement-breakpoint
CREATE INDEX "questions_category_id_idx" ON "questions" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "questions_event_id_idx" ON "questions" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "questions_active_idx" ON "questions" USING btree ("active");--> statement-breakpoint
CREATE INDEX "score_events_match_id_idx" ON "score_events" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "score_events_team_id_idx" ON "score_events" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "score_events_question_id_idx" ON "score_events" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "score_events_bonus_lookup_idx" ON "score_events" USING btree ("match_id","team_id","question_id","type");--> statement-breakpoint
CREATE INDEX "team_members_team_id_idx" ON "team_members" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_members_participant_id_idx" ON "team_members" USING btree ("participant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_members_participant_id_unique" ON "team_members" USING btree ("participant_id");--> statement-breakpoint
CREATE INDEX "teams_event_id_idx" ON "teams" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "teams_school_id_idx" ON "teams" USING btree ("school_id");