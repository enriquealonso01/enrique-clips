export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      ai_fix_history: {
        Row: {
          created_at: string
          error_message: string | null
          feedback: string
          id: string
          project_id: string
          rerun_triggered: boolean
          result_json: Json | null
          run_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          feedback: string
          id?: string
          project_id: string
          rerun_triggered?: boolean
          result_json?: Json | null
          run_id?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          feedback?: string
          id?: string
          project_id?: string
          rerun_triggered?: boolean
          result_json?: Json | null
          run_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_fix_history_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          created_at: string
          id: string
          metadata: Json | null
          run_id: string | null
          scene_id: string | null
          signed_url_last: string | null
          supabase_path: string
          type: Database["public"]["Enums"]["asset_type"]
        }
        Insert: {
          created_at?: string
          id?: string
          metadata?: Json | null
          run_id?: string | null
          scene_id?: string | null
          signed_url_last?: string | null
          supabase_path: string
          type: Database["public"]["Enums"]["asset_type"]
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json | null
          run_id?: string | null
          scene_id?: string | null
          signed_url_last?: string | null
          supabase_path?: string
          type?: Database["public"]["Enums"]["asset_type"]
        }
        Relationships: [
          {
            foreignKeyName: "assets_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_scene_id_fkey"
            columns: ["scene_id"]
            isOneToOne: false
            referencedRelation: "scenes"
            referencedColumns: ["id"]
          },
        ]
      }
      overlays: {
        Row: {
          bg_color: string | null
          content_mode: string
          content_prompt: string | null
          content_text: string | null
          created_at: string
          end_pct: number
          font_color: string | null
          font_size: number | null
          id: string
          image_path: string | null
          overlay_type: string
          position: string
          project_id: string
          sort_order: number
          source: string
          start_pct: number
          style: string
          voiceover_enabled: boolean
          z_index: number
        }
        Insert: {
          bg_color?: string | null
          content_mode?: string
          content_prompt?: string | null
          content_text?: string | null
          created_at?: string
          end_pct?: number
          font_color?: string | null
          font_size?: number | null
          id?: string
          image_path?: string | null
          overlay_type?: string
          position?: string
          project_id: string
          sort_order?: number
          source?: string
          start_pct?: number
          style?: string
          voiceover_enabled?: boolean
          z_index?: number
        }
        Update: {
          bg_color?: string | null
          content_mode?: string
          content_prompt?: string | null
          content_text?: string | null
          created_at?: string
          end_pct?: number
          font_color?: string | null
          font_size?: number | null
          id?: string
          image_path?: string | null
          overlay_type?: string
          position?: string
          project_id?: string
          sort_order?: number
          source?: string
          start_pct?: number
          style?: string
          voiceover_enabled?: boolean
          z_index?: number
        }
        Relationships: [
          {
            foreignKeyName: "overlays_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      project_tracks: {
        Row: {
          created_at: string
          id: string
          project_id: string
          track_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          project_id: string
          track_id: string
        }
        Update: {
          created_at?: string
          id?: string
          project_id?: string
          track_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_tracks_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "project_tracks_track_id_fkey"
            columns: ["track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          aspect_ratio: string
          clip_duration_sec: number
          created_at: string
          facebook_image_post_enabled: boolean
          id: string
          initial_asset_id: string | null
          is_enabled: boolean
          kling_mode: string
          kling_model_name: string
          kling_sound: boolean
          last_run_at: string | null
          negative_prompt: string | null
          pika_model: string
          pika_resolution: string
          posting_cron: string | null
          posting_frequency_type: Database["public"]["Enums"]["posting_frequency"]
          posting_interval_hours: number | null
          project_control_token_hash: string | null
          project_control_token_hint: string | null
          prompt_config_json: Json | null
          publish_defaults: Json
          publish_platforms: Json
          scene_count: number
          selected_track_id: string | null
          series_prompt: string | null
          series_rules: string | null
          timezone: string
          title: string
          updated_at: string
          uploadpost_api_key_configured: boolean
          uploadpost_api_key_encrypted: string | null
          uploadpost_profile_username: string | null
          video_generator: Database["public"]["Enums"]["video_generator"]
        }
        Insert: {
          aspect_ratio?: string
          clip_duration_sec?: number
          created_at?: string
          facebook_image_post_enabled?: boolean
          id?: string
          initial_asset_id?: string | null
          is_enabled?: boolean
          kling_mode?: string
          kling_model_name?: string
          kling_sound?: boolean
          last_run_at?: string | null
          negative_prompt?: string | null
          pika_model?: string
          pika_resolution?: string
          posting_cron?: string | null
          posting_frequency_type?: Database["public"]["Enums"]["posting_frequency"]
          posting_interval_hours?: number | null
          project_control_token_hash?: string | null
          project_control_token_hint?: string | null
          prompt_config_json?: Json | null
          publish_defaults?: Json
          publish_platforms?: Json
          scene_count?: number
          selected_track_id?: string | null
          series_prompt?: string | null
          series_rules?: string | null
          timezone?: string
          title?: string
          updated_at?: string
          uploadpost_api_key_configured?: boolean
          uploadpost_api_key_encrypted?: string | null
          uploadpost_profile_username?: string | null
          video_generator?: Database["public"]["Enums"]["video_generator"]
        }
        Update: {
          aspect_ratio?: string
          clip_duration_sec?: number
          created_at?: string
          facebook_image_post_enabled?: boolean
          id?: string
          initial_asset_id?: string | null
          is_enabled?: boolean
          kling_mode?: string
          kling_model_name?: string
          kling_sound?: boolean
          last_run_at?: string | null
          negative_prompt?: string | null
          pika_model?: string
          pika_resolution?: string
          posting_cron?: string | null
          posting_frequency_type?: Database["public"]["Enums"]["posting_frequency"]
          posting_interval_hours?: number | null
          project_control_token_hash?: string | null
          project_control_token_hint?: string | null
          prompt_config_json?: Json | null
          publish_defaults?: Json
          publish_platforms?: Json
          scene_count?: number
          selected_track_id?: string | null
          series_prompt?: string | null
          series_rules?: string | null
          timezone?: string
          title?: string
          updated_at?: string
          uploadpost_api_key_configured?: boolean
          uploadpost_api_key_encrypted?: string | null
          uploadpost_profile_username?: string | null
          video_generator?: Database["public"]["Enums"]["video_generator"]
        }
        Relationships: [
          {
            foreignKeyName: "fk_initial_asset"
            columns: ["initial_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "projects_selected_track_id_fkey"
            columns: ["selected_track_id"]
            isOneToOne: false
            referencedRelation: "tracks"
            referencedColumns: ["id"]
          },
        ]
      }
      publish_jobs: {
        Row: {
          created_at: string
          id: string
          platform_results: Json | null
          run_id: string
          status: Database["public"]["Enums"]["publish_job_status"]
          updated_at: string
          uploadpost_job_id: string | null
          uploadpost_request_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          platform_results?: Json | null
          run_id: string
          status?: Database["public"]["Enums"]["publish_job_status"]
          updated_at?: string
          uploadpost_job_id?: string | null
          uploadpost_request_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          platform_results?: Json | null
          run_id?: string
          status?: Database["public"]["Enums"]["publish_job_status"]
          updated_at?: string
          uploadpost_job_id?: string | null
          uploadpost_request_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "publish_jobs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      run_logs: {
        Row: {
          created_at: string
          data: Json | null
          id: string
          level: Database["public"]["Enums"]["log_level"]
          message: string
          run_id: string
        }
        Insert: {
          created_at?: string
          data?: Json | null
          id?: string
          level?: Database["public"]["Enums"]["log_level"]
          message: string
          run_id: string
        }
        Update: {
          created_at?: string
          data?: Json | null
          id?: string
          level?: Database["public"]["Enums"]["log_level"]
          message?: string
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "run_logs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      runs: {
        Row: {
          created_at: string
          current_step: Database["public"]["Enums"]["run_step"]
          error_message: string | null
          finished_at: string | null
          generated_metadata: Json | null
          id: string
          progress_pct: number
          project_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["run_status"]
          topic_summary: string | null
        }
        Insert: {
          created_at?: string
          current_step?: Database["public"]["Enums"]["run_step"]
          error_message?: string | null
          finished_at?: string | null
          generated_metadata?: Json | null
          id?: string
          progress_pct?: number
          project_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
          topic_summary?: string | null
        }
        Update: {
          created_at?: string
          current_step?: Database["public"]["Enums"]["run_step"]
          error_message?: string | null
          finished_at?: string | null
          generated_metadata?: Json | null
          id?: string
          progress_pct?: number
          project_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["run_status"]
          topic_summary?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "runs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      scenes: {
        Row: {
          activity_density:
            | Database["public"]["Enums"]["activity_density"]
            | null
          created_at: string
          end_keyframe_prompt: string | null
          id: string
          kling_prompt: string | null
          run_id: string
          scene_behavior: Database["public"]["Enums"]["scene_behavior"] | null
          scene_description: string | null
          scene_index: number
          scene_title: string | null
          status: Database["public"]["Enums"]["scene_status"]
        }
        Insert: {
          activity_density?:
            | Database["public"]["Enums"]["activity_density"]
            | null
          created_at?: string
          end_keyframe_prompt?: string | null
          id?: string
          kling_prompt?: string | null
          run_id: string
          scene_behavior?: Database["public"]["Enums"]["scene_behavior"] | null
          scene_description?: string | null
          scene_index: number
          scene_title?: string | null
          status?: Database["public"]["Enums"]["scene_status"]
        }
        Update: {
          activity_density?:
            | Database["public"]["Enums"]["activity_density"]
            | null
          created_at?: string
          end_keyframe_prompt?: string | null
          id?: string
          kling_prompt?: string | null
          run_id?: string
          scene_behavior?: Database["public"]["Enums"]["scene_behavior"] | null
          scene_description?: string | null
          scene_index?: number
          scene_title?: string | null
          status?: Database["public"]["Enums"]["scene_status"]
        }
        Relationships: [
          {
            foreignKeyName: "scenes_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "runs"
            referencedColumns: ["id"]
          },
        ]
      }
      schedules: {
        Row: {
          created_at: string
          days_of_week: number[]
          id: string
          is_enabled: boolean
          last_triggered_at: string | null
          project_id: string
          scheduled_post_time: string | null
          scheduled_post_time_end: string | null
          time_utc: string
        }
        Insert: {
          created_at?: string
          days_of_week?: number[]
          id?: string
          is_enabled?: boolean
          last_triggered_at?: string | null
          project_id: string
          scheduled_post_time?: string | null
          scheduled_post_time_end?: string | null
          time_utc: string
        }
        Update: {
          created_at?: string
          days_of_week?: number[]
          id?: string
          is_enabled?: boolean
          last_triggered_at?: string | null
          project_id?: string
          scheduled_post_time?: string | null
          scheduled_post_time_end?: string | null
          time_utc?: string
        }
        Relationships: [
          {
            foreignKeyName: "schedules_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      story_assets: {
        Row: {
          created_at: string
          id: string
          metadata: Json | null
          run_id: string | null
          scene_index: number | null
          signed_url_last: string | null
          supabase_path: string
          type: Database["public"]["Enums"]["story_asset_type"]
        }
        Insert: {
          created_at?: string
          id?: string
          metadata?: Json | null
          run_id?: string | null
          scene_index?: number | null
          signed_url_last?: string | null
          supabase_path: string
          type: Database["public"]["Enums"]["story_asset_type"]
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json | null
          run_id?: string | null
          scene_index?: number | null
          signed_url_last?: string | null
          supabase_path?: string
          type?: Database["public"]["Enums"]["story_asset_type"]
        }
        Relationships: [
          {
            foreignKeyName: "story_assets_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "story_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      story_memory: {
        Row: {
          created_at: string
          id: string
          project_id: string
          run_id: string | null
          source_url: string | null
          story_fingerprint: string | null
          story_title: string
        }
        Insert: {
          created_at?: string
          id?: string
          project_id: string
          run_id?: string | null
          source_url?: string | null
          story_fingerprint?: string | null
          story_title: string
        }
        Update: {
          created_at?: string
          id?: string
          project_id?: string
          run_id?: string | null
          source_url?: string | null
          story_fingerprint?: string | null
          story_title?: string
        }
        Relationships: [
          {
            foreignKeyName: "story_memory_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "story_projects"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "story_memory_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "story_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      story_projects: {
        Row: {
          background_music_path: string | null
          config_json: Json | null
          created_at: string
          emoji_path: string | null
          ending_audio_path: string | null
          id: string
          is_enabled: boolean
          publish_defaults: Json
          publish_platforms: Json
          target_duration_sec: number
          timezone: string
          title: string
          updated_at: string
        }
        Insert: {
          background_music_path?: string | null
          config_json?: Json | null
          created_at?: string
          emoji_path?: string | null
          ending_audio_path?: string | null
          id?: string
          is_enabled?: boolean
          publish_defaults?: Json
          publish_platforms?: Json
          target_duration_sec?: number
          timezone?: string
          title?: string
          updated_at?: string
        }
        Update: {
          background_music_path?: string | null
          config_json?: Json | null
          created_at?: string
          emoji_path?: string | null
          ending_audio_path?: string | null
          id?: string
          is_enabled?: boolean
          publish_defaults?: Json
          publish_platforms?: Json
          target_duration_sec?: number
          timezone?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      story_run_logs: {
        Row: {
          created_at: string
          data: Json | null
          id: string
          level: Database["public"]["Enums"]["log_level"]
          message: string
          run_id: string
        }
        Insert: {
          created_at?: string
          data?: Json | null
          id?: string
          level?: Database["public"]["Enums"]["log_level"]
          message: string
          run_id: string
        }
        Update: {
          created_at?: string
          data?: Json | null
          id?: string
          level?: Database["public"]["Enums"]["log_level"]
          message?: string
          run_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "story_run_logs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "story_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      story_runs: {
        Row: {
          created_at: string
          current_stage: string
          error_message: string | null
          finished_at: string | null
          generated_metadata: Json | null
          id: string
          progress_pct: number
          project_id: string
          started_at: string | null
          status: Database["public"]["Enums"]["story_run_status"]
        }
        Insert: {
          created_at?: string
          current_stage?: string
          error_message?: string | null
          finished_at?: string | null
          generated_metadata?: Json | null
          id?: string
          progress_pct?: number
          project_id: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["story_run_status"]
        }
        Update: {
          created_at?: string
          current_stage?: string
          error_message?: string | null
          finished_at?: string | null
          generated_metadata?: Json | null
          id?: string
          progress_pct?: number
          project_id?: string
          started_at?: string | null
          status?: Database["public"]["Enums"]["story_run_status"]
        }
        Relationships: [
          {
            foreignKeyName: "story_runs_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "story_projects"
            referencedColumns: ["id"]
          },
        ]
      }
      tracks: {
        Row: {
          created_at: string
          duration_sec: number | null
          filename: string
          id: string
          supabase_path: string
          title: string
        }
        Insert: {
          created_at?: string
          duration_sec?: number | null
          filename: string
          id?: string
          supabase_path: string
          title: string
        }
        Update: {
          created_at?: string
          duration_sec?: number | null
          filename?: string
          id?: string
          supabase_path?: string
          title?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      get_random_project_track: {
        Args: { p_project_id: string }
        Returns: {
          track_id: string
        }[]
      }
    }
    Enums: {
      activity_density: "low" | "medium" | "high"
      asset_type:
        | "initial_image"
        | "keyframe"
        | "clip"
        | "final_video"
        | "thumbnail"
      log_level: "debug" | "info" | "warn" | "error"
      posting_frequency: "manual" | "interval_hours" | "cron"
      publish_job_status:
        | "not_started"
        | "submitted"
        | "polling"
        | "completed"
        | "failed"
        | "partial_failed"
      run_status:
        | "queued"
        | "running"
        | "paused"
        | "stopped"
        | "failed"
        | "completed"
      run_step:
        | "plan"
        | "keyframes"
        | "kling"
        | "stitch"
        | "metadata"
        | "publish"
        | "done"
      scene_behavior:
        | "environment_idle"
        | "cinematic_action"
        | "timelapse_build"
        | "conversation"
        | "exploration"
        | "reveal"
      scene_status:
        | "pending"
        | "keyframes_ready"
        | "clip_requested"
        | "clip_ready"
        | "failed"
      story_asset_type:
        | "background_music"
        | "ending_audio"
        | "narration_audio"
        | "real_image"
        | "cast_reference_image"
        | "scene_image"
        | "scene_video_raw"
        | "scene_video_trimmed"
        | "captioned_story_video"
        | "ending_visual_clip"
        | "ending_audio_trimmed"
        | "final_video"
        | "emoji"
      story_run_status:
        | "queued"
        | "researching_story"
        | "story_selected"
        | "cast_generated"
        | "narration_generated"
        | "beats_extracted"
        | "scene_images_generating"
        | "scenes_generating"
        | "audio_mixing"
        | "subtitles_processing"
        | "end_card_rendering"
        | "ready_to_publish"
        | "publishing"
        | "published"
        | "paused"
        | "failed"
        | "cancelled"
      video_generator: "kling" | "pika" | "vidu" | "vidu_direct"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      activity_density: ["low", "medium", "high"],
      asset_type: [
        "initial_image",
        "keyframe",
        "clip",
        "final_video",
        "thumbnail",
      ],
      log_level: ["debug", "info", "warn", "error"],
      posting_frequency: ["manual", "interval_hours", "cron"],
      publish_job_status: [
        "not_started",
        "submitted",
        "polling",
        "completed",
        "failed",
        "partial_failed",
      ],
      run_status: [
        "queued",
        "running",
        "paused",
        "stopped",
        "failed",
        "completed",
      ],
      run_step: [
        "plan",
        "keyframes",
        "kling",
        "stitch",
        "metadata",
        "publish",
        "done",
      ],
      scene_behavior: [
        "environment_idle",
        "cinematic_action",
        "timelapse_build",
        "conversation",
        "exploration",
        "reveal",
      ],
      scene_status: [
        "pending",
        "keyframes_ready",
        "clip_requested",
        "clip_ready",
        "failed",
      ],
      story_asset_type: [
        "background_music",
        "ending_audio",
        "narration_audio",
        "real_image",
        "cast_reference_image",
        "scene_image",
        "scene_video_raw",
        "scene_video_trimmed",
        "captioned_story_video",
        "ending_visual_clip",
        "ending_audio_trimmed",
        "final_video",
        "emoji",
      ],
      story_run_status: [
        "queued",
        "researching_story",
        "story_selected",
        "cast_generated",
        "narration_generated",
        "beats_extracted",
        "scene_images_generating",
        "scenes_generating",
        "audio_mixing",
        "subtitles_processing",
        "end_card_rendering",
        "ready_to_publish",
        "publishing",
        "published",
        "paused",
        "failed",
        "cancelled",
      ],
      video_generator: ["kling", "pika", "vidu", "vidu_direct"],
    },
  },
} as const
