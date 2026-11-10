package com.limorelay.app;

import android.os.Bundle;
import android.view.View;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // Android 15+ draws apps edge to edge. Keep the page below the status bar and above the buttons.
    View root = findViewById(android.R.id.content);
    ViewCompat.setOnApplyWindowInsetsListener(root, (v, windowInsets) -> {
      Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
      boolean keyboard = windowInsets.isVisible(WindowInsetsCompat.Type.ime());
      // With the keyboard open, Capacitor already shrinks the page for it; do not pad twice.
      v.setPadding(bars.left, bars.top, bars.right, keyboard ? 0 : bars.bottom);
      return new WindowInsetsCompat.Builder(windowInsets)
          .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.NONE)
          .setInsets(WindowInsetsCompat.Type.displayCutout(), Insets.NONE)
          .build();
    });
  }
}
