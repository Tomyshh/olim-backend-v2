import 'package:olim_service/core/constants/const.dart';
import 'package:olim_service/core/services/database_service.dart';

/// Utilitaires pour calculer le temps de traitement (processTime) ajusté selon le forfait
class ProcessTimeUtils {
  /// Calcule le processTime ajusté selon le forfait de l'utilisateur
  /// 
  /// Le forfait Start garde les temps actuels (point de départ).
  /// Les autres forfaits ont des temps réduits :
  /// - Essential : 80% du temps Start (réduction de 20%)
  /// - VIP : 60% du temps Start (réduction de 40%)
  /// - ELITE : 40% du temps Start (réduction de 60%)
  /// 
  /// [baseProcessTime] : Le temps de base (celui du forfait Start)
  /// [membership] : Le forfait de l'utilisateur
  /// 
  /// Retourne le processTime ajusté selon le forfait
  static String calculateAdjustedProcessTime(
    String baseProcessTime,
    String? membership,
  ) {
    // Si pas de membership ou Start, retourner le temps de base
    if (membership == null ||
        membership == MembershipType_PackStart ||
        membership == MembershipType_Visitor) {
      return baseProcessTime;
    }

    // Extraire le nombre et l'unité du temps de base
    final adjustedTime = _adjustTimeString(baseProcessTime, membership);
    return adjustedTime;
  }

  /// Ajuste une chaîne de temps selon le forfait
  static String _adjustTimeString(String timeString, String membership) {
    // Déterminer le facteur de réduction selon le forfait
    double reductionFactor;
    switch (membership) {
      case MembershipType_PackEssential:
        reductionFactor = 0.8; // 80% du temps (réduction de 20%)
        break;
      case MembershipType_PackVIP:
        reductionFactor = 0.6; // 60% du temps (réduction de 40%)
        break;
      case MembershipType_PackElite:
        reductionFactor = 0.4; // 40% du temps (réduction de 60%)
        break;
      default:
        return timeString; // Pas de changement pour les autres cas
    }

    // Parser la chaîne de temps pour extraire le nombre et l'unité
    final timeData = _parseTimeString(timeString);
    if (timeData == null) {
      return timeString; // Si on ne peut pas parser, retourner l'original
    }

    // Calculer le nouveau temps
    final baseValue = timeData['value'] as int;
    final calculatedValue = baseValue * reductionFactor;
    final unit = timeData['unit'] as String;
    final prefix = timeData['prefix'] as String? ?? '';

    // Si le résultat est < 1 jour et que l'unité est "jour" ou "jours",
    // convertir en heures pour les forfaits premium
    if (calculatedValue < 1.0 && (unit == 'jour' || unit == 'jours')) {
      // Convertir en heures (1 jour = 24 heures)
      final hours = (calculatedValue * 24).ceil();
      if (hours >= 1) {
        return _formatTimeString(hours, 'heures', '');
      }
    }

    // Sinon, arrondir normalement
    final newValue = calculatedValue.ceil();

    // Formater le résultat
    return _formatTimeString(newValue, unit, prefix);
  }

  /// Parse une chaîne de temps pour extraire la valeur numérique et l'unité
  /// Exemples : "3 jours" -> {value: 3, unit: "jours"}
  ///            "1-2 jours" -> {value: 2, unit: "jours", prefix: "1-"}
  ///            "deux à quatre semaines" -> {value: 4, unit: "semaines"}
  static Map<String, dynamic>? _parseTimeString(String timeString) {
    if (timeString.isEmpty) return null;

    // Normaliser la chaîne (minuscules, supprimer espaces multiples)
    final normalized = timeString.toLowerCase().trim();

    // Patterns pour différents formats
    // Format simple : "3 jours", "2 semaines", etc.
    final simplePattern = RegExp(r'^(\d+)\s+(jour|jours|semaine|semaines|mois|heure|heures)$');
    final simpleMatch = simplePattern.firstMatch(normalized);
    if (simpleMatch != null) {
      return {
        'value': int.parse(simpleMatch.group(1)!),
        'unit': simpleMatch.group(2)!,
      };
    }

    // Format avec plage : "1-2 jours", "2-3 semaines", etc.
    final rangePattern = RegExp(r'^(\d+)\s*-\s*(\d+)\s+(jour|jours|semaine|semaines|mois|heure|heures)$');
    final rangeMatch = rangePattern.firstMatch(normalized);
    if (rangeMatch != null) {
      final maxValue = int.parse(rangeMatch.group(2)!);
      return {
        'value': maxValue,
        'unit': rangeMatch.group(3)!,
        'prefix': '${rangeMatch.group(1)!}-',
      };
    }

    // Format avec "à" : "deux à quatre semaines"
    final aPattern = RegExp(r'^(\w+)\s+à\s+(\w+)\s+(jour|jours|semaine|semaines|mois|heure|heures)$');
    final aMatch = aPattern.firstMatch(normalized);
    if (aMatch != null) {
      final firstWord = aMatch.group(1)!;
      final secondWord = aMatch.group(2)!;
      final unit = aMatch.group(3)!;
      
      // Convertir les mots en nombres (approximatif)
      final firstNum = _wordToNumber(firstWord);
      final secondNum = _wordToNumber(secondWord);
      
      if (firstNum != null && secondNum != null) {
        return {
          'value': secondNum, // Prendre la valeur max
          'unit': unit,
          'prefix': '$firstWord à ',
        };
      }
    }

    // Si aucun pattern ne correspond, essayer d'extraire juste un nombre
    final numberPattern = RegExp(r'\d+');
    final numberMatch = numberPattern.firstMatch(normalized);
    if (numberMatch != null) {
      final value = int.parse(numberMatch.group(0)!);
      // Essayer de trouver l'unité
      String? unit;
      if (normalized.contains('jour')) unit = 'jours';
      else if (normalized.contains('semaine')) unit = 'semaines';
      else if (normalized.contains('mois')) unit = 'mois';
      else if (normalized.contains('heure')) unit = 'heures';
      
      if (unit != null) {
        return {
          'value': value,
          'unit': unit,
        };
      }
    }

    return null;
  }

  /// Convertit un mot en nombre (approximatif pour les nombres en lettres)
  static int? _wordToNumber(String word) {
    final wordLower = word.toLowerCase();
    final numberMap = {
      'un': 1, 'une': 1,
      'deux': 2,
      'trois': 3,
      'quatre': 4,
      'cinq': 5,
      'six': 6,
      'sept': 7,
      'huit': 8,
      'neuf': 9,
      'dix': 10,
    };
    return numberMap[wordLower];
  }

  /// Formate une valeur de temps en chaîne
  static String _formatTimeString(int value, String unit, String prefix) {
    // Si la valeur est 0 ou négative après réduction, mettre au minimum 1
    final finalValue = value < 1 ? 1 : value;
    
    // Gérer le pluriel
    String finalUnit = unit;
    if (finalValue > 1 && !unit.endsWith('s')) {
      if (unit == 'jour') finalUnit = 'jours';
      else if (unit == 'semaine') finalUnit = 'semaines';
      else if (unit == 'heure') finalUnit = 'heures';
    } else if (finalValue == 1 && unit.endsWith('s')) {
      if (unit == 'jours') finalUnit = 'jour';
      else if (unit == 'semaines') finalUnit = 'semaine';
      else if (unit == 'heures') finalUnit = 'heure';
    }

    return '$prefix$finalValue $finalUnit';
  }

  /// Récupère le processTime ajusté de manière asynchrone
  /// Utile quand on a besoin de récupérer le membership de l'utilisateur
  static Future<String> getAdjustedProcessTimeAsync(
    String baseProcessTime,
  ) async {
    try {
      final db = DatabaseService();
      final membership = await db.getMembershipFromSubscription();
      return calculateAdjustedProcessTime(baseProcessTime, membership);
    } catch (e) {
      // En cas d'erreur, retourner le temps de base
      return baseProcessTime;
    }
  }
}

